import { Emitter } from "@dogfight/shared/emitter";
import { assertNever } from "@dogfight/shared/types";
import {
  type ClientMessage,
  decode,
  encode,
  FATAL_CLOSE_CODES,
  type ServerMessage,
} from "./protocol.ts";

const READY = { OPEN: 1 } as const;

// Події з'єднання. Повідомлення сервера адресуються за `type`: ключ
// "snapshot" -> SnapshotMessage, "chat" -> повідомлення чату тощо (mapped
// type з перейменуванням ключів виводить словник із union-а). Службові події
// додані поруч, тож `conn.on(...)` типізований для всіх разом.
export type ServerEvents = { [M in ServerMessage as M["type"]]: M };

export interface CloseInfo {
  code: number;
  reason: string;
  willRetry: boolean;
}

export type DropReason = "buffered" | "offline" | "queue-full";

export type ConnectionEvents = ServerEvents & {
  open: undefined;
  close: CloseInfo;
  reconnecting: { attempt: number; delayMs: number };
  dropped: { type: string; reason: DropReason };
  "bad-message": unknown;
};

export interface ConnectionStats {
  bytesIn: number;
  bytesOut: number;
  messagesIn: number;
  messagesOut: number;
}

// Мінімум, потрібний від WebSocket (його підміняють у тестах). Обробники
// описані як методи-«bivariance hack», щоб справжній WebSocket (з MessageEvent
// і CloseEvent) підходив під цей інтерфейс.
type Listener<E> = { bivarianceHack(event: E): void }["bivarianceHack"];

export interface SocketLike {
  binaryType: string;
  readonly readyState: number;
  readonly bufferedAmount: number;
  onopen: Listener<unknown> | null;
  onmessage: Listener<{ data: unknown }> | null;
  onerror: Listener<unknown> | null;
  onclose: Listener<{ code: number; reason: string }> | null;
  send(data: string | Uint8Array<ArrayBuffer>): void;
  close(code?: number, reason?: string): void;
}

export type SocketConstructor = new (url: string) => SocketLike;
type TimerHandle = ReturnType<typeof setTimeout>;

export interface ConnectionOptions {
  url: string;
  WebSocketImpl?: SocketConstructor;
  backoff?: { baseMs: number; factor: number; maxMs: number };
  maxQueue?: number;
  bufferedLimit?: number;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}

// Розмір кадру в байтах (для статистики): рядок — у символах.
function frameSize(data: unknown): number {
  if (typeof data === "string") return data.length;
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data))
    return data.byteLength;
  return 0;
}

// Обгортка WebSocket: диспетчер за `type`, черга відправки, перепідключення.
//
//   const conn = createConnection({ url });
//   conn.on("open", () => conn.send({ type: "join", room, name, codec }));
//   conn.on("chat", (msg) => ...);          // msg: повідомлення чату
//   conn.on("reconnecting", ({ attempt, delayMs }) => ...);
//   conn.on("close", ({ code, reason, willRetry }) => ...);
//
// Службові події: "open", "close", "reconnecting", "dropped", "bad-message".
// Усе, що можна підмінити (WebSocket, таймери, random), передається
// параметрами — тому поведінку перевіряють тести без браузера.
export function createConnection({
  url,
  WebSocketImpl = WebSocket,
  backoff = { baseMs: 500, factor: 2, maxMs: 10_000 },
  maxQueue = 100,
  bufferedLimit = 1_048_576,
  random = Math.random,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}: ConnectionOptions) {
  const events = new Emitter<ConnectionEvents>();
  let socket: SocketLike | null = null;
  let queue: string[] = [];
  let attempt = 0;
  let retryTimer: TimerHandle | null = null;
  let intentionalClose = false;
  // Лічильники для netgraph (байти — корисне навантаження кадрів).
  const stats: ConnectionStats = {
    bytesIn: 0,
    bytesOut: 0,
    messagesIn: 0,
    messagesOut: 0,
  };

  // Диспетчеризація повідомлення сервера: вичерпний switch за type, тож новий
  // варіант ServerMessage без обробки тут не скомпілюється.
  function dispatch(msg: ServerMessage): void {
    switch (msg.type) {
      case "joined":
        return events.emit("joined", msg);
      case "roster":
        return events.emit("roster", msg);
      case "chat":
        return events.emit("chat", msg);
      case "error":
        return events.emit("error", msg);
      case "shutdown":
        return events.emit("shutdown", msg);
      case "snapshot":
        return events.emit("snapshot", msg);
      case "events":
        return events.emit("events", msg);
      case "pong":
        return events.emit("pong", msg);
      default:
        return assertNever(msg, "повідомлення сервера");
    }
  }

  function open(): void {
    const ws = new WebSocketImpl(url);
    socket = ws;
    // Бінарні кадри хочемо як ArrayBuffer (а не Blob): DataView читає синхронно.
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      attempt = 0; // успішне з'єднання скидає backoff
      // 1) Спершу "open": обробник може надіслати join, і він піде першим.
      events.emit("open", undefined);
      // 2) Потім скидаємо накопичену чергу в тому ж порядку.
      const pending = queue;
      queue = [];
      for (const data of pending) ws.send(data);
    };

    ws.onmessage = (event) => {
      stats.bytesIn += frameSize(event.data);
      stats.messagesIn++;
      const msg = decode(event.data);
      if (msg === null) {
        events.emit("bad-message", event.data);
        return;
      }
      dispatch(msg);
    };

    // Помилку не обробляємо окремо: за нею завжди йде close.
    ws.onerror = () => {};

    ws.onclose = (event) => {
      socket = null;
      const willRetry = !intentionalClose && !FATAL_CLOSE_CODES.has(event.code);
      events.emit("close", {
        code: event.code,
        reason: event.reason,
        willRetry,
      });
      if (willRetry) scheduleReconnect();
    };
  }

  // Експоненційний backoff із повним jitter, щоб після падіння сервера
  // тисячі клієнтів не стукали одночасно.
  function scheduleReconnect(): void {
    const ceiling = Math.min(
      backoff.maxMs,
      backoff.baseMs * backoff.factor ** attempt,
    );
    const delayMs = Math.round(random() * ceiling);
    attempt++;
    events.emit("reconnecting", { attempt, delayMs });
    retryTimer = setTimer(() => {
      retryTimer = null;
      open();
    }, delayMs);
  }

  return {
    stats,
    connect(): void {
      intentionalClose = false;
      if (socket === null && retryTimer === null) open();
    },

    // critical (join, chat): ставимо в чергу, якщо з'єднання немає.
    // не critical (часті оновлення): при затору або розриві просто пропускаємо —
    // наступне оновлення все одно актуальніше.
    send(
      message: ClientMessage,
      { critical = true }: { critical?: boolean } = {},
    ): boolean {
      const data = encode(message);
      if (socket?.readyState === READY.OPEN) {
        stats.bytesOut += data.length;
        stats.messagesOut++;
        if (!critical && socket.bufferedAmount > bufferedLimit) {
          events.emit("dropped", { type: message.type, reason: "buffered" });
          return false;
        }
        socket.send(data);
        return true;
      }
      if (!critical) {
        events.emit("dropped", { type: message.type, reason: "offline" });
        return false;
      }
      if (queue.length >= maxQueue) {
        queue.shift(); // найстаріше менш цінне за нове
        events.emit("dropped", { type: message.type, reason: "queue-full" });
      }
      queue.push(data);
      return true;
    },

    // Ігрове повідомлення вже закодоване (Uint8Array або рядок). Ніколи не
    // ставиться в чергу: застарілий input після reconnect лише зашкодить.
    sendGame(data: Uint8Array<ArrayBuffer> | string): boolean {
      if (socket?.readyState !== READY.OPEN) return false;
      if (socket.bufferedAmount > bufferedLimit) {
        events.emit("dropped", { type: "game", reason: "buffered" });
        return false;
      }
      stats.bytesOut += frameSize(data);
      stats.messagesOut++;
      socket.send(data);
      return true;
    },

    on<K extends keyof ConnectionEvents>(
      type: K,
      handler: (detail: ConnectionEvents[K]) => void,
    ): () => void {
      return events.on(type, handler);
    },

    close(code = 1000, reason = "client closing"): void {
      intentionalClose = true;
      if (retryTimer !== null) clearTimer(retryTimer);
      retryTimer = null;
      queue = [];
      socket?.close(code, reason);
    },

    get connected(): boolean {
      return socket?.readyState === READY.OPEN;
    },
    get queued(): number {
      return queue.length;
    },
  };
}

export type Connection = ReturnType<typeof createConnection>;
