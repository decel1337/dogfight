import { FATAL_CLOSE_CODES, decode, encode } from "./protocol.js";

const READY = { OPEN: 1 };

// Обгортка WebSocket: диспетчер за `type`, черга відправки, перепідключення.
//
//   const conn = createConnection({ url });
//   conn.on("open", () => conn.send("join", { room, name }));
//   conn.on("chat", (msg) => ...);          // за msg.type
//   conn.on("reconnecting", ({ attempt, delayMs }) => ...);
//   conn.on("close", ({ code, reason, willRetry }) => ...);
//
// Службові події: "open", "close", "reconnecting", "dropped", "bad-message".
// Усе, що можна підмінити (WebSocket, таймери, random), передається
// параметрами — тому поведінку перевіряють тести без браузера.
export function createConnection({
  url,
  WebSocketImpl = globalThis.WebSocket,
  backoff = { baseMs: 500, factor: 2, maxMs: 10_000 },
  maxQueue = 100,
  bufferedLimit = 1_048_576,
  random = Math.random,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const handlers = new Map(); // type -> Set<fn>
  let socket = null;
  let queue = [];
  let attempt = 0;
  let retryTimer = null;
  let intentionalClose = false;

  const emit = (type, payload) => {
    for (const handler of handlers.get(type) ?? []) handler(payload);
  };

  function open() {
    socket = new WebSocketImpl(url);

    socket.onopen = () => {
      attempt = 0; // успішне з'єднання скидає backoff
      // 1) Спершу "open": обробник може надіслати join, і він піде першим.
      emit("open");
      // 2) Потім скидаємо накопичену чергу в тому ж порядку.
      const pending = queue;
      queue = [];
      for (const data of pending) socket.send(data);
    };

    socket.onmessage = (event) => {
      const msg = decode(event.data);
      if (msg === null) {
        emit("bad-message", event.data);
        return;
      }
      emit(msg.type, msg);
    };

    // Помилку не обробляємо окремо: за нею завжди йде close.
    socket.onerror = () => {};

    socket.onclose = (event) => {
      socket = null;
      const willRetry = !intentionalClose && !FATAL_CLOSE_CODES.has(event.code);
      emit("close", { code: event.code, reason: event.reason, willRetry });
      if (willRetry) scheduleReconnect();
    };
  }

  // Експоненційний backoff із повним jitter, щоб після падіння сервера
  // тисячі клієнтів не стукали одночасно.
  function scheduleReconnect() {
    const ceiling = Math.min(
      backoff.maxMs,
      backoff.baseMs * backoff.factor ** attempt,
    );
    const delayMs = Math.round(random() * ceiling);
    attempt++;
    emit("reconnecting", { attempt, delayMs });
    retryTimer = setTimer(() => {
      retryTimer = null;
      open();
    }, delayMs);
  }

  return {
    connect() {
      intentionalClose = false;
      if (socket === null && retryTimer === null) open();
    },

    // critical (join, chat): ставимо в чергу, якщо з'єднання немає.
    // не critical (часті оновлення): при затору або розриві просто пропускаємо —
    // наступне оновлення все одно актуальніше.
    send(type, payload, { critical = true } = {}) {
      const data = encode(type, payload);
      if (socket?.readyState === READY.OPEN) {
        if (!critical && socket.bufferedAmount > bufferedLimit) {
          emit("dropped", { type, reason: "buffered" });
          return false;
        }
        socket.send(data);
        return true;
      }
      if (!critical) {
        emit("dropped", { type, reason: "offline" });
        return false;
      }
      if (queue.length >= maxQueue) {
        queue.shift(); // найстаріше менш цінне за нове
        emit("dropped", { type, reason: "queue-full" });
      }
      queue.push(data);
      return true;
    },

    on(type, handler) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(handler);
      return () => handlers.get(type)?.delete(handler);
    },

    close(code = 1000, reason = "client closing") {
      intentionalClose = true;
      clearTimer(retryTimer);
      retryTimer = null;
      queue = [];
      socket?.close(code, reason);
    },

    get connected() {
      return socket?.readyState === READY.OPEN;
    },
    get queued() {
      return queue.length;
    },
  };
}
