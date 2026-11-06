import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { MatchLogs } from "./log/matchlog.js";
import { silentLogger } from "./logger.js";
import { RoomManager, TooManyRoomsError } from "./rooms.js";
import { serveStatic } from "./static.js";
import { attachWebSocket } from "./ws.js";

// Помилка, яку можна показати клієнту як є (4xx).
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const REPLAY_ID_RE = /^[\w-]{1,100}$/;

function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    ...JSON_HEADERS,
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(data);
}

function allow(req, methods) {
  if (!methods.includes(req.method)) {
    throw Object.assign(new HttpError(405, "метод не підтримується"), {
      headers: { allow: methods.join(", ") },
    });
  }
}

// Читаємо тіло з жорстким лімітом. Перевищення -> 413, а решту тіла
// відкидаємо (resume), не накопичуючи в пам'яті.
function readBody(req, maxBytes) {
  const declared = Number(req.headers["content-length"]);
  if (declared > maxBytes) {
    req.resume();
    return Promise.reject(new HttpError(413, "тіло запиту завелике"));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const onData = (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.off("data", onData);
        req.resume();
        reject(new HttpError(413, "тіло запиту завелике"));
        return;
      }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.once("end", () => resolve(Buffer.concat(chunks)));
    req.once("error", reject);
  });
}

async function readJson(req, maxBytes) {
  const type = req.headers["content-type"] ?? "";
  if (!type.toLowerCase().startsWith("application/json")) {
    req.resume();
    throw new HttpError(415, "очікується Content-Type: application/json");
  }
  const raw = await readBody(req, maxBytes);
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new HttpError(400, "некоректний JSON");
  }
}

const isInt = (value, min, max) =>
  Number.isInteger(value) && value >= min && value <= max;

// Перевіряємо кожне поле й копіюємо лише відомі: зайве з тіла не потрапляє
// далі в систему.
export function validateRoomInput(body, config) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "очікується JSON-об'єкт");
  }
  const input = {};

  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length < 1 || name.length > 32) {
      throw new HttpError(400, "name: рядок 1–32 символи");
    }
    input.name = name;
  }
  if (body.maxPlayers !== undefined) {
    if (!isInt(body.maxPlayers, 1, config.maxPlayersPerRoom)) {
      throw new HttpError(
        400,
        `maxPlayers: ціле 1..${config.maxPlayersPerRoom}`,
      );
    }
    input.maxPlayers = body.maxPlayers;
  }
  if (body.arena !== undefined) {
    const { width, height } = body.arena ?? {};
    if (!isInt(width, 400, 4000) || !isInt(height, 400, 4000)) {
      throw new HttpError(400, "arena: width і height — цілі 400..4000");
    }
    input.arena = { width, height };
  }
  return input;
}

export function createApp({ config, log = silentLogger }) {
  const rooms = new RoomManager({
    maxRooms: config.maxRooms,
    maxPlayers: config.maxPlayersPerRoom,
    idleMs: config.roomIdleMs,
  });
  const matchLogs = new MatchLogs({ dir: config.logDir, log });

  // Кожній новій кімнаті — власний лог матчу.
  rooms.on("created", (room) => {
    room.logId = matchLogs.start(room).id;
  });

  const startedAt = Date.now();
  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => onRequestError(req, res, error));
  });
  const ws = attachWebSocket({ server, rooms, config, log });

  // Некоректний HTTP від клієнта — не привід падати.
  server.on("clientError", (_error, socket) => {
    if (socket.writable)
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    else socket.destroy();
  });

  function onRequestError(req, res, error) {
    if (error instanceof HttpError) {
      if (!res.headersSent) {
        sendJson(
          res,
          error.status,
          { error: error.message },
          {
            ...error.headers,
            ...(error.status === 413 ? { connection: "close" } : {}),
          },
        );
      }
      return;
    }
    log.error("request failed", {
      url: req.url,
      error: error.stack ?? String(error),
    });
    if (!res.headersSent) sendJson(res, 500, { error: "внутрішня помилка" });
    else res.destroy();
  }

  async function handle(req, res) {
    const { pathname } = new URL(req.url, "http://localhost");

    if (pathname === "/health") {
      allow(req, ["GET", "HEAD"]);
      return sendJson(res, 200, {
        status: "ok",
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        rooms: rooms.size,
        clients: ws.stats().clients,
        rss: process.memoryUsage.rss(),
      });
    }

    // Діагностика такту: тривалість тика й «тремтіння» таймера (мс).
    if (pathname === "/api/stats") {
      allow(req, ["GET", "HEAD"]);
      return sendJson(res, 200, { tickRate: 30, matches: ws.matchStats() });
    }

    if (pathname === "/api/rooms") {
      allow(req, ["GET", "HEAD", "POST"]);
      if (req.method !== "POST") return sendJson(res, 200, rooms.list());

      const input = validateRoomInput(
        await readJson(req, config.maxBodyBytes),
        config,
      );
      try {
        const room = rooms.create(input);
        return sendJson(res, 201, room.summary(), {
          location: `/api/rooms/${room.id}`,
        });
      } catch (error) {
        if (error instanceof TooManyRoomsError)
          throw new HttpError(429, error.message);
        throw error;
      }
    }

    if (pathname === "/api/replays") {
      allow(req, ["GET", "HEAD"]);
      return sendJson(res, 200, await listReplays());
    }

    const replayMatch = /^\/api\/replays(-naive)?\/([^/]+)$/.exec(pathname);
    if (replayMatch) {
      allow(req, ["GET"]);
      const [, naive, id] = replayMatch;
      if (naive && !config.debugRoutes) throw new HttpError(404, "не знайдено");
      return serveReplay(res, id, { naive: Boolean(naive) });
    }

    // Лише для демонстрації event loop (ENABLE_DEBUG_ROUTES=1).
    if (config.debugRoutes && pathname === "/api/slow") {
      const end = performance.now() + 300;
      while (performance.now() < end); // синхронно блокує ВЕСЬ процес
      return sendJson(res, 200, { blockedMs: 300 });
    }
    if (config.debugRoutes && pathname === "/api/slow-async") {
      await delay(300); // чекає, але цикл подій вільний
      return sendJson(res, 200, { waitedMs: 300 });
    }

    if (pathname.startsWith("/api/")) throw new HttpError(404, "не знайдено");

    const staticInfo = await stat(config.staticDir).catch(() => null);
    if (!staticInfo?.isDirectory()) {
      throw new HttpError(
        404,
        "клієнт не зібрано: npm run build, або відкрийте Vite (5173)",
      );
    }
    return serveStatic(req, res, config.staticDir, pathname);
  }

  async function listReplays() {
    const files = await readdir(config.logDir).catch(() => []);
    const items = [];
    for (const file of files) {
      if (!file.endsWith(".ndjson")) continue;
      const info = await stat(path.join(config.logDir, file));
      items.push({
        id: file.slice(0, -".ndjson".length),
        bytes: info.size,
        modified: info.mtime.toISOString(),
      });
    }
    return items.sort((a, b) => b.modified.localeCompare(a.modified));
  }

  // Потокова віддача логу. pipeline зупиняє читання файлу, поки сокет
  // клієнта не «осушить» буфер (backpressure), тож пам'ять не росте
  // незалежно від розміру файлу та швидкості клієнта.
  async function serveReplay(res, id, { naive }) {
    if (!REPLAY_ID_RE.test(id)) throw new HttpError(400, "некоректний id");
    const file = path.join(config.logDir, `${id}.ndjson`);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) throw new HttpError(404, "запис не знайдено");

    res.writeHead(200, { "content-type": "application/x-ndjson" });
    if (naive) {
      // АНТИПРИКЛАД (для порівняння в README): весь файл у пам'ять.
      res.end(await readFile(file));
      return;
    }
    try {
      await pipeline(createReadStream(file), res);
    } catch (error) {
      // Клієнт обірвав завантаження — це нормально, не помилка сервера.
      if (error.code !== "ERR_STREAM_PREMATURE_CLOSE") throw error;
    }
  }

  let stopping = null;

  return {
    server,
    rooms,
    matchLogs,
    ws,

    start() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => {
          server.off("error", reject);
          resolve(server.address());
        });
      });
    },

    // Graceful shutdown: перестаємо приймати з'єднання, ввічливо закриваємо
    // сокети (1001), закриваємо кімнати, дочікуємось запису логів.
    stop() {
      stopping ??= (async () => {
        log.info("shutdown: stop accepting connections");
        const closed = new Promise((resolve) => server.close(resolve));
        server.closeIdleConnections();

        ws.closeAll();
        rooms.closeAll();
        await matchLogs.flush();
        log.info("shutdown: match logs flushed");

        // Решту (повільні клієнти) добиваємо за таймаутом.
        const force = setTimeout(
          () => server.closeAllConnections(),
          config.shutdownTimeoutMs,
        );
        await closed;
        clearTimeout(force);
        log.info("shutdown: complete");
      })();
      return stopping;
    },
  };
}
