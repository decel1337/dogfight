import type http from "node:http";
import type { Duplex } from "node:stream";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { TICK_RATE } from "@dogfight/shared/constants";
import { type Codec, encodeSnapshot, getCodec, parseClientBinary, withAck } from "@dogfight/shared/codec";
import {
  CLOSE,
  type ClientMessage,
  type CloseCode,
  type ParseResult,
  type ServerMessage,
  encode,
  parseClientMessage,
} from "@dogfight/shared/protocol";
import { assertNever } from "@dogfight/shared/types";
import type { Config } from "./config.ts";
import type { Logger } from "./logger.ts";
import { BotPool } from "./bots.ts";
import { Match, type MatchFrame } from "./match.ts";
import { NetSim } from "./netsim.ts";
import { TokenBucket } from "./ratelimit.ts";
import { type Player, type Room, RoomFullError, type RoomManager } from "./rooms.ts";

// Стан одного з'єднання. player і room з'являються разом після join: ця пара
// полів і є «приєднаний» стан, тож перевіряємо `state.room` і `state.player`.
interface ConnState {
  readonly id: number;
  player: Player | null;
  room: Room | null;
  awaitingPong: boolean;
  missedPongs: number;
  dropped: number;
  readonly bucket: TokenBucket;
  readonly inputBucket: TokenBucket;
  codec: Codec;
  readonly netsim: NetSim;
}

// Те саме з гарантією приєднання: після `joined(state)` поля не null.
interface JoinedState extends ConnState {
  player: Player;
  room: Room;
}
const isJoined = (state: ConnState): state is JoinedState =>
  state.player !== null && state.room !== null;

type SendOptions = { critical: boolean };
type DeliverOptions = SendOptions & { reliable: boolean };

const toBytes = (data: RawData): Uint8Array =>
  Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : data;

// Причина закриття в кадрі close обмежена 123 байтами.
const shortReason = (text: string): string => String(text).slice(0, 100);

// Життєвий цикл WebSocket-з'єднань: join із таймаутом, валідація кожного
// повідомлення, rate limit, heartbeat, політика повільних клієнтів.
export function attachWebSocket({
  server,
  rooms,
  config,
  log,
}: {
  server: http.Server;
  rooms: RoomManager;
  config: Config;
  log: Logger;
}) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: config.maxPayload, // більший кадр -> закриття з кодом 1009
  });
  const clients = new Set<WebSocket>();
  const states = new WeakMap<WebSocket, ConnState>();
  const hubs = new WeakMap<Room, Set<WebSocket>>(); // лише ті, хто зайшов
  const matches = new Map<Room, Match>();
  const botPools = new Map<Room, BotPool>();

  const stateOf = (ws: WebSocket): ConnState => {
    const state = states.get(ws);
    if (!state) throw new Error("з'єднання без стану");
    return state;
  };
  let nextSocketId = 0;

  // --- Upgrade: приймаємо лише /ws -------------------------------------
  server.on("upgrade", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    // До завершення рукостискання помилки сокета теж треба слухати.
    socket.on("error", (error: Error) => log.warn("upgrade socket error", { error: error.message }));

    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    if (pathname !== "/ws") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  // --- Допоміжне: закриття та безпечна відправка ----------------------
  function closeWith(ws: WebSocket, code: number, reason: string): void {
    if (ws.readyState !== ws.OPEN && ws.readyState !== ws.CONNECTING) return;
    ws.close(code, shortReason(reason));
    // Якщо клієнт не відповість closing-кадром, не чекаємо 30 с.
    setTimeout(() => {
      if (ws.readyState !== ws.CLOSED) ws.terminate();
    }, 2000).unref();
  }

  function fail(ws: WebSocket, code: CloseCode, message: string): void {
    sendRaw(ws, encode({ type: "error", message }));
    closeWith(ws, code, message);
  }

  function sendRaw(ws: WebSocket, data: string | Uint8Array): boolean {
    if (ws.readyState !== ws.OPEN) return false;
    ws.send(data, (error?: Error) => {
      if (error) log.warn("send failed", { error: error.message });
    });
    return true;
  }

  // Політика повільного клієнта. Якщо буфер відправки переповнений
  // (bufferedAmount росте, бо клієнт не встигає читати):
  //  - некритичні повідомлення (chat) ПРОПУСКАЄМО й рахуємо;
  //  - критичні (roster, joined) — клієнт уже не синхронізований,
  //    тож закриваємо з кодом 4006 і звільняємо пам'ять.
  function safeSend(ws: WebSocket, data: string | Uint8Array, { critical }: SendOptions): boolean {
    if (ws.readyState !== ws.OPEN) return false;
    if (ws.bufferedAmount > config.bufferedLimit) {
      const state = states.get(ws);
      if (critical) {
        log.warn("slow client closed", { socket: state?.id, buffered: ws.bufferedAmount });
        closeWith(ws, CLOSE.SLOW_CLIENT, "slow client");
      } else if (state) {
        state.dropped++;
      }
      return false;
    }
    return sendRaw(ws, data);
  }

  // Відправка крізь імітатор мережі. Керування (chat, roster) — надійне
  // (FIFO), ігрові повідомлення — ненадійні (можуть губитись).
  function deliver(
    ws: WebSocket,
    data: string | Uint8Array,
    { critical, reliable }: DeliverOptions,
  ): void {
    const state = stateOf(ws);
    state.netsim.pass(() => safeSend(ws, data, { critical }), { reliable });
  }

  function broadcast(room: Room, message: ServerMessage, { critical }: SendOptions): void {
    const hub = hubs.get(room);
    if (!hub) return;
    const data = encode(message); // серіалізуємо один раз для всіх
    for (const ws of hub) deliver(ws, data, { critical, reliable: true });
  }

  // Кадр матчу -> кожному гравцеві: снапшот зі СВОЇМ ack і спільні події.
  // Снапшот — повний стан, тож пропущений через повільного клієнта
  // снапшот не критичний (наступний його замінить).
  function broadcastFrame(room: Room, frame: MatchFrame): void {
    const hub = hubs.get(room);
    if (!hub || hub.size === 0) return;
    const encoded: Partial<Record<Codec["name"], string | Uint8Array>> = {}; // events: по разу на кодек
    let baseSnapshot: Uint8Array<ArrayBuffer> | undefined;
    for (const ws of hub) {
      const state = stateOf(ws);
      if (!isJoined(state)) continue;
      const ack = frame.acks.get(state.player.id) ?? 0;
      let data: string | Uint8Array;
      if (state.codec.binary) {
        // Бінарний снапшот кодуємо раз за тик; на клієнта — лише копія з його ack.
        baseSnapshot ??= encodeSnapshot({
          type: "snapshot",
          tick: frame.tick,
          ack: 0,
          entities: frame.snapshot.entities,
        });
        data = withAck(baseSnapshot, ack);
      } else {
        data = state.codec.encode({
          type: "snapshot",
          tick: frame.tick,
          ack,
          entities: frame.snapshot.entities,
        });
      }
      deliver(ws, data, { critical: false, reliable: false });
      if (frame.events.length > 0) {
        const data = (encoded[state.codec.name] ??= state.codec.encode({
          type: "events",
          tick: frame.tick,
          events: frame.events,
        }));
        deliver(ws, data, { critical: false, reliable: false });
      }
    }
  }

  // --- Кожна нова кімната отримує слухачів -----------------------------
  rooms.on("created", (room) => {
    hubs.set(room, new Set());
    const match = new Match({ room });
    matches.set(room, match);
    match.on("frame", (frame) => broadcastFrame(room, frame));
    botPools.set(room, new BotPool(match));
    const roster = (): void =>
      broadcast(room, { type: "roster", players: room.roster() }, { critical: true });
    room.on("join", roster);
    room.on("leave", roster);
    room.on("chat", (message) =>
      broadcast(room, { type: "chat", ...message }, { critical: false }),
    );
    room.once("closed", () => {
      match.stop();
      botPools.get(room)?.dispose();
      botPools.delete(room);
      matches.delete(room);
      for (const ws of hubs.get(room) ?? []) closeWith(ws, CLOSE.GOING_AWAY, "room closed");
      hubs.delete(room);
    });
  });

  // --- З'єднання --------------------------------------------------------
  wss.on("connection", (ws, req) => {
    const state: ConnState = {
      id: ++nextSocketId,
      player: null,
      room: null,
      awaitingPong: false,
      missedPongs: 0,
      dropped: 0,
      bucket: new TokenBucket({ ratePerSec: config.ratePerSec, burst: config.rateBurst }),
      inputBucket: new TokenBucket({
        ratePerSec: config.inputRatePerSec,
        burst: config.inputRateBurst,
      }),
      codec: getCodec("binary"),
      netsim: new NetSim(),
    };
    states.set(ws, state);
    clients.add(ws);
    log.info("socket open", { socket: state.id, ip: req.socket.remoteAddress });

    // ОБОВ'ЯЗКОВО: без слухача "error" будь-яка помилка сокета
    // (напр. оверсайз-кадр, обрив) була б необробленою подією і
    // поклала б увесь процес.
    ws.on("error", (error: Error) => {
      log.warn("socket error", { socket: state.id, error: error.message });
    });

    // Клієнт має представитися протягом joinTimeoutMs.
    const joinTimer = setTimeout(() => {
      if (!state.room) fail(ws, CLOSE.JOIN_TIMEOUT, "join timeout");
    }, config.joinTimeoutMs);

    ws.on("pong", () => {
      state.awaitingPong = false;
      state.missedPongs = 0;
    });

    ws.on("message", (data: RawData, isBinary: boolean) => {
      // Спершу розбираємо й перевіряємо, потім витрачаємо токени: ігрові
      // повідомлення (input/ping) мають власне відро.
      let parsed: ParseResult<ClientMessage>;
      if (isBinary) {
        // Бінарні кадри — лише для ігрових повідомлень після join.
        if (!state.room || state.codec.name !== "binary") {
          fail(ws, CLOSE.UNSUPPORTED, "binary frames are not supported");
          return;
        }
        if (!state.inputBucket.take()) {
          fail(ws, CLOSE.RATE_LIMITED, "rate limit exceeded");
          return;
        }
        parsed = parseClientBinary(toBytes(data), { maxBytes: config.maxPayload });
      } else {
        parsed = parseClientMessage(toBytes(data), { maxBytes: config.maxPayload });
        const game = parsed.ok && (parsed.msg.type === "input" || parsed.msg.type === "ping");
        const bucket = game ? state.inputBucket : state.bucket;
        if (!bucket.take()) {
          fail(ws, CLOSE.RATE_LIMITED, "rate limit exceeded");
          return;
        }
      }
      if (!parsed.ok) {
        log.warn("invalid message", { socket: state.id, reason: parsed.reason });
        fail(ws, parsed.code, parsed.reason);
        return;
      }

      const { msg } = parsed;
      switch (msg.type) {
        case "join":
          onJoin(ws, state, msg, joinTimer);
          break;
        case "chat":
          // Чат ходить «надійним» каналом: затримка є, втрат немає.
          state.netsim.pass(() => onChat(ws, state, msg.text), { reliable: true });
          break;
        case "net":
          onNet(ws, state, msg);
          break;
        case "input":
        case "ping":
          if (!isJoined(state)) {
            fail(ws, CLOSE.INVALID_MESSAGE, "join first");
            return;
          }
          state.netsim.pass(() => onGame(ws, state, msg), { reliable: false });
          break;
        default:
          assertNever(msg, "повідомлення клієнта");
      }
    });

    ws.on("close", (code: number) => {
      clearTimeout(joinTimer);
      clients.delete(ws);
      state.netsim.close();
      if (isJoined(state)) {
        hubs.get(state.room)?.delete(ws); // спершу виходимо з розсилки
        matches.get(state.room)?.removePlayer(state.player.id);
        state.room.remove(state.player.id);
      }
      log.info("socket close", { socket: state.id, code, dropped: state.dropped });
    });
  });

  function onJoin(
    ws: WebSocket,
    state: ConnState,
    msg: Extract<ClientMessage, { type: "join" }>,
    joinTimer: NodeJS.Timeout,
  ): void {
    if (state.room) {
      fail(ws, CLOSE.INVALID_MESSAGE, "already joined");
      return;
    }
    const room = rooms.get(msg.room);
    if (!room) {
      fail(ws, CLOSE.ROOM_NOT_FOUND, "room not found");
      return;
    }

    let player: Player;
    try {
      player = room.add(msg.name);
    } catch (error: unknown) {
      if (error instanceof RoomFullError) {
        fail(ws, CLOSE.ROOM_FULL, "room is full");
        return;
      }
      throw error;
    }

    clearTimeout(joinTimer);
    state.room = room;
    state.player = player;
    state.codec = getCodec(msg.codec);

    const match = matches.get(room);
    if (!match) throw new Error(`немає матчу для кімнати ${room.id}`);
    const ship = match.addPlayer(player);
    if (!match.ticker.running) match.start();

    // Спершу joined + roster самому гравцеві, потім він потрапляє в розсилку
    // (інші вже отримали roster через подію "join" кімнати).
    safeSend(
      ws,
      encode({
        type: "joined",
        you: player,
        room: room.summary(),
        ship: ship.id,
        seed: match.seed,
        tickRate: TICK_RATE,
        tick: match.world.tick,
        arena: room.arena,
        codec: state.codec.name,
        netsim: config.enableNetsim,
      }),
      { critical: true },
    );
    safeSend(ws, encode({ type: "roster", players: room.roster() }), { critical: true });
    hubs.get(room)?.add(ws);
    log.info("player joined", { socket: state.id, room: room.id, name: player.name });
  }

  function onChat(ws: WebSocket, state: ConnState, text: string): void {
    if (!isJoined(state)) {
      fail(ws, CLOSE.INVALID_MESSAGE, "join first");
      return;
    }
    state.room.chat(state.player.id, text);
  }

  // Налаштування імітації мережі для цього з'єднання.
  function onNet(
    ws: WebSocket,
    state: ConnState,
    msg: Extract<ClientMessage, { type: "net" }>,
  ): void {
    if (!config.enableNetsim) {
      fail(ws, CLOSE.INVALID_MESSAGE, "netsim disabled");
      return;
    }
    state.netsim.configure(msg);
    log.info("netsim", { socket: state.id, latency: msg.latency, jitter: msg.jitter, drop: msg.drop });
  }

  function onGame(
    ws: WebSocket,
    state: JoinedState,
    msg: Extract<ClientMessage, { type: "input" | "ping" }>,
  ): void {
    if (ws.readyState !== ws.OPEN) return;
    const match = matches.get(state.room);
    if (!match) return;
    if (msg.type === "input") {
      match.receiveInput(state.player.id, msg);
    } else {
      // pong несе ехо часу клієнта й поточний тик сервера (для RTT і годинника)
      deliver(ws, state.codec.encode({ type: "pong", tick: match.world.tick, t: msg.t }), {
        critical: false,
        reliable: false,
      });
    }
  }

  // --- Heartbeat --------------------------------------------------------
  // Раз на heartbeatMs: якщо попередній ping лишився без pong — це
  // пропущений pong. maxMissedPongs підряд -> terminate (сокет «мертвий»).
  const heartbeat = setInterval(() => {
    for (const ws of clients) {
      const state = stateOf(ws);
      if (state.awaitingPong) {
        state.missedPongs++;
        if (state.missedPongs >= config.maxMissedPongs) {
          log.warn("heartbeat lost", { socket: state.id, missed: state.missedPongs });
          ws.terminate();
          continue;
        }
      }
      state.awaitingPong = true;
      ws.ping();
    }
  }, config.heartbeatMs);
  heartbeat.unref();

  return {
    wss,
    clients,
    stats: () => ({ clients: clients.size }),
    // Боти кімнати: count — скільки додати (0 = прибрати всіх). Повертає кількість ботів.
    setBots(room: Room, op: "add" | "clear", count = 0): number | null {
      const pool = botPools.get(room);
      if (!pool) return null;
      if (op === "add") pool.add(count);
      else pool.clear();
      return pool.size;
    },
    matchStats: () => [...matches.values()].map((m) => m.stats()),
    // Для graceful shutdown: закриваємо ввічливо, а добивати — за таймером.
    closeAll(code: number = CLOSE.GOING_AWAY, reason = "server shutting down"): void {
      clearInterval(heartbeat);
      for (const match of matches.values()) match.stop();
      for (const ws of clients) closeWith(ws, code, reason);
    },
  };
}
