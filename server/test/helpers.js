import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { decodeBinary } from "@dogfight/shared/codec";
import { WebSocket } from "ws";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { silentLogger } from "../src/logger.js";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function tempDir(prefix = "dogfight-") {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

// Піднімає справжній сервер на вільному порту й гарантовано зупиняє його.
export async function withApp(overrides, run) {
  const logDir = tempDir("logs-");
  const staticDir = tempDir("static-");
  const config = loadConfig({
    PORT: "0",
    HOST: "127.0.0.1",
    LOG_DIR: logDir,
    STATIC_DIR: staticDir,
    ...overrides,
  });
  const app = createApp({ config, log: silentLogger });
  const { port } = await app.start();
  const ctx = {
    app,
    config,
    logDir,
    staticDir,
    port,
    http: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
  };
  try {
    return await run(ctx);
  } finally {
    await app.stop().catch(() => {});
    await rm(logDir, { recursive: true, force: true });
    await rm(staticDir, { recursive: true, force: true });
  }
}

export async function createRoom(ctx, body = { name: "test" }) {
  const res = await fetch(`${ctx.http}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

// Клієнт із чергою повідомлень: next(type) чекає на повідомлення потрібного типу.
export function connect(url, options) {
  const ws = new WebSocket(url, options);
  const inbox = [];
  const waiters = [];

  const drain = () => {
    for (const waiter of [...waiters]) {
      const index = inbox.findIndex((m) => m.type === waiter.type);
      if (index === -1) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(inbox.splice(index, 1)[0]);
    }
  };

  ws.on("message", (data, isBinary) => {
    inbox.push(isBinary ? decodeBinary(data) : JSON.parse(data.toString()));
    drain();
  });
  ws.on("error", () => {}); // помилки тестового клієнта не мають валити тест

  const closed = new Promise((resolve) => {
    ws.on("close", (code, reason) =>
      resolve({ code, reason: reason.toString() }),
    );
  });

  const opened = new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  return {
    ws,
    inbox,
    closed,
    opened,
    send: (msg) => ws.send(JSON.stringify({ v: 1, ...msg })),
    next(type, timeoutMs = 1500) {
      return new Promise((resolve, reject) => {
        const waiter = { type, resolve };
        waiters.push(waiter);
        drain();
        setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index === -1) return;
          waiters.splice(index, 1);
          reject(new Error(`очікувалось повідомлення "${type}"`));
        }, timeoutMs).unref();
      });
    },
  };
}

export async function joined(ctx, roomId, name) {
  const client = connect(ctx.wsUrl);
  await client.opened;
  client.send({ type: "join", room: roomId, name });
  await client.next("joined");
  return client;
}
