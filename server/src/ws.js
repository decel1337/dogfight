import { WebSocketServer } from "ws";
import { TICK_RATE } from "@dogfight/shared/constants";
import { getCodec, parseClientBinary } from "@dogfight/shared/codec";
import { CLOSE, encode, parseClientMessage } from "@dogfight/shared/protocol";
import { Match } from "./match.js";
import { NetSim } from "./netsim.js";
import { RoomFullError } from "./rooms.js";
import { TokenBucket } from "./ratelimit.js";

// Причина закриття в кадрі close обмежена 123 байтами.
const shortReason = (text) => String(text).slice(0, 100);

// Життєвий цикл WebSocket-з'єднань: join із таймаутом, валідація кожного
// повідомлення, rate limit, heartbeat, політика повільних клієнтів.
export function attachWebSocket({ server, rooms, config, log }) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: config.maxPayload, // більший кадр -> закриття з кодом 1009
  });
  const clients = new Set();
  const states = new WeakMap(); // socket -> { id, player, room, bucket, ... }
  const hubs = new WeakMap(); // room -> Set<socket> (лише ті, хто зайшов)
  const matches = new Map(); // room -> Match
  let nextSocketId = 0;

  // --- Upgrade: приймаємо лише /ws -------------------------------------
  server.on("upgrade", (req, socket, head) => {
    // До завершення рукостискання помилки сокета теж треба слухати.
    socket.on("error", (error) =>
      log.warn("upgrade socket error", { error: error.message }),
    );

    const { pathname } = new URL(req.url, "http://localhost");
    if (pathname !== "/ws") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit("connection", ws, req),
    );
  });

  // --- Допоміжне: закриття та безпечна відправка ----------------------
  function closeWith(ws, code, reason) {
    if (ws.readyState !== ws.OPEN && ws.readyState !== ws.CONNECTING) return;
    ws.close(code, shortReason(reason));
    // Якщо клієнт не відповість closing-кадром, не чекаємо 30 с.
    setTimeout(() => {
      if (ws.readyState !== ws.CLOSED) ws.terminate();
    }, 2000).unref();
  }

  function fail(ws, code, message) {
    sendRaw(ws, encode("error", { message }));
    closeWith(ws, code, message);
  }

  function sendRaw(ws, data) {
    if (ws.readyState !== ws.OPEN) return false;
    ws.send(data, (error) => {
      if (error) log.warn("send failed", { error: error.message });
    });
    return true;
  }

  // Політика повільного клієнта. Якщо буфер відправки переповнений
  // (bufferedAmount росте, бо клієнт не встигає читати):
  //  - некритичні повідомлення (chat) ПРОПУСКАЄМО й рахуємо;
  //  - критичні (roster, joined) — клієнт уже не синхронізований,
  //    тож закриваємо з кодом 4006 і звільняємо пам'ять.
  function safeSend(ws, data, { critical }) {
    if (ws.readyState !== ws.OPEN) return false;
    if (ws.bufferedAmount > config.bufferedLimit) {
      const state = states.get(ws);
      if (critical) {
        log.warn("slow client closed", {
          socket: state?.id,
          buffered: ws.bufferedAmount,
        });
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
  function deliver(ws, data, { critical, reliable }) {
    const state = states.get(ws);
    state.netsim.pass(() => safeSend(ws, data, { critical }), { reliable });
  }

  function broadcast(room, type, payload, { critical }) {
    const hub = hubs.get(room);
    if (!hub) return;
    const data = encode(type, payload); // серіалізуємо один раз для всіх
    for (const ws of hub) deliver(ws, data, { critical, reliable: true });
  }

  // Кадр матчу -> кожному гравцеві: снапшот зі СВОЇМ ack і спільні події.
  // Снапшот — повний стан, тож пропущений через повільного клієнта
  // снапшот не критичний (наступний його замінить).
  function broadcastFrame(room, frame) {
    const hub = hubs.get(room);
    if (!hub || hub.size === 0) return;
    const encoded = { binary: null, json: null }; // events: по разу на кодек
    for (const ws of hub) {
      const state = states.get(ws);
      const snapshot = {
        type: "snapshot",
        tick: frame.tick,
        ack: frame.acks.get(state.player.id) ?? 0,
        entities: frame.snapshot.entities,
      };
      deliver(ws, state.codec.encode(snapshot), {
        critical: false,
        reliable: false,
      });
      if (frame.events.length > 0) {
        encoded[state.codec.name] ??= state.codec.encode({
          type: "events",
          tick: frame.tick,
          events: frame.events,
        });
        deliver(ws, encoded[state.codec.name], {
          critical: false,
          reliable: false,
        });
      }
    }
  }

  // --- Кожна нова кімната отримує слухачів -----------------------------
  rooms.on("created", (room) => {
    hubs.set(room, new Set());
    const match = new Match({ room });
    matches.set(room, match);
    match.on("frame", (frame) => broadcastFrame(room, frame));
    const roster = () =>
      broadcast(room, "roster", { players: room.roster() }, { critical: true });
    room.on("join", roster);
    room.on("leave", roster);
    room.on("chat", (message) =>
      broadcast(room, "chat", message, { critical: false }),
    );
    room.once("closed", () => {
      match.stop();
      matches.delete(room);
      for (const ws of hubs.get(room) ?? [])
        closeWith(ws, CLOSE.GOING_AWAY, "room closed");
      hubs.delete(room);
    });
  });

  // --- З'єднання --------------------------------------------------------
  wss.on("connection", (ws, req) => {
    const state = {
      id: ++nextSocketId,
      player: null,
      room: null,
      awaitingPong: false,
      missedPongs: 0,
      dropped: 0,
      bucket: new TokenBucket({
        ratePerSec: config.ratePerSec,
        burst: config.rateBurst,
      }),
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
    ws.on("error", (error) => {
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

    ws.on("message", (data, isBinary) => {
      // Спершу розбираємо й перевіряємо, потім витрачаємо токени: ігрові
      // повідомлення (input/ping) мають власне відро.
      let parsed;
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
        parsed = parseClientBinary(data, { maxBytes: config.maxPayload });
      } else {
        parsed = parseClientMessage(data, { maxBytes: config.maxPayload });
        const game =
          parsed.ok &&
          (parsed.msg.type === "input" || parsed.msg.type === "ping");
        const bucket = game ? state.inputBucket : state.bucket;
        if (!bucket.take()) {
          fail(ws, CLOSE.RATE_LIMITED, "rate limit exceeded");
          return;
        }
      }
      if (!parsed.ok) {
        log.warn("invalid message", {
          socket: state.id,
          reason: parsed.reason,
        });
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
          state.netsim.pass(() => onChat(ws, state, msg), { reliable: true });
          break;
        case "net":
          onNet(ws, state, msg);
          break;
        case "input":
        case "ping":
          if (!state.room) {
            fail(ws, CLOSE.INVALID_MESSAGE, "join first");
            return;
          }
          state.netsim.pass(() => onGame(ws, state, msg), { reliable: false });
          break;
      }
    });

    ws.on("close", (code) => {
      clearTimeout(joinTimer);
      clients.delete(ws);
      state.netsim.close();
      if (state.room) {
        hubs.get(state.room)?.delete(ws); // спершу виходимо з розсилки
        matches.get(state.room)?.removePlayer(state.player.id);
        state.room.remove(state.player.id);
      }
      log.info("socket close", {
        socket: state.id,
        code,
        dropped: state.dropped,
      });
    });
  });

  function onJoin(ws, state, msg, joinTimer) {
    if (state.room) {
      fail(ws, CLOSE.INVALID_MESSAGE, "already joined");
      return;
    }
    const room = rooms.get(msg.room);
    if (!room) {
      fail(ws, CLOSE.ROOM_NOT_FOUND, "room not found");
      return;
    }

    let player;
    try {
      player = room.add(msg.name);
    } catch (error) {
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
    const ship = match.addPlayer(player);
    if (!match.ticker.running) match.start();

    // Спершу joined + roster самому гравцеві, потім він потрапляє в розсилку
    // (інші вже отримали roster через подію "join" кімнати).
    safeSend(
      ws,
      encode("joined", {
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
    safeSend(ws, encode("roster", { players: room.roster() }), {
      critical: true,
    });
    hubs.get(room)?.add(ws);
    log.info("player joined", {
      socket: state.id,
      room: room.id,
      name: player.name,
    });
  }

  function onChat(ws, state, msg) {
    if (!state.room) {
      fail(ws, CLOSE.INVALID_MESSAGE, "join first");
      return;
    }
    state.room.chat(state.player.id, msg.text);
  }

  // Налаштування імітації мережі для цього з'єднання.
  function onNet(ws, state, msg) {
    if (!config.enableNetsim) {
      fail(ws, CLOSE.INVALID_MESSAGE, "netsim disabled");
      return;
    }
    state.netsim.configure(msg);
    log.info("netsim", {
      socket: state.id,
      latency: msg.latency,
      jitter: msg.jitter,
      drop: msg.drop,
    });
  }

  function onGame(ws, state, msg) {
    if (ws.readyState !== ws.OPEN) return;
    const match = matches.get(state.room);
    if (!match) return;
    if (msg.type === "input") {
      match.receiveInput(state.player.id, msg);
    } else {
      // pong несе ехо часу клієнта й поточний тик сервера (для RTT і годинника)
      deliver(
        ws,
        state.codec.encode({ type: "pong", tick: match.world.tick, t: msg.t }),
        {
          critical: false,
          reliable: false,
        },
      );
    }
  }

  // --- Heartbeat --------------------------------------------------------
  // Раз на heartbeatMs: якщо попередній ping лишився без pong — це
  // пропущений pong. maxMissedPongs підряд -> terminate (сокет «мертвий»).
  const heartbeat = setInterval(() => {
    for (const ws of clients) {
      const state = states.get(ws);
      if (state.awaitingPong) {
        state.missedPongs++;
        if (state.missedPongs >= config.maxMissedPongs) {
          log.warn("heartbeat lost", {
            socket: state.id,
            missed: state.missedPongs,
          });
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
    matchStats: () => [...matches.values()].map((m) => m.stats()),
    // Для graceful shutdown: закриваємо ввічливо, а добивати — за таймером.
    closeAll(code = CLOSE.GOING_AWAY, reason = "server shutting down") {
      clearInterval(heartbeat);
      for (const match of matches.values()) match.stop();
      for (const ws of clients) closeWith(ws, code, reason);
    },
  };
}
