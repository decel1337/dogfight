import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { decodeBinary } from "@dogfight/shared/codec";
import {
  type ClientMessage,
  decodeServerJson,
  type ServerMessage,
} from "@dogfight/shared/protocol";
import { type RawData, WebSocket } from "ws";
import { type App, createApp } from "../src/app.ts";
import { type Config, loadConfig } from "../src/config.ts";
import { silentLogger } from "../src/logger.ts";

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function tempDir(prefix = "dogfight-"): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

// Піднімає справжній сервер на вільному порту й гарантовано зупиняє його.
export interface AppContext {
  app: App;
  config: Config;
  logDir: string;
  staticDir: string;
  port: number;
  http: string;
  wsUrl: string;
}

export async function withApp<T>(
  overrides: Record<string, string>,
  run: (ctx: AppContext) => Promise<T>,
): Promise<T> {
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
  const ctx: AppContext = {
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

export interface RoomJson {
  id: string;
  name: string;
  players: number;
  maxPlayers: number;
  arena: { width: number; height: number };
}

export async function createRoom(
  ctx: Pick<AppContext, "http">,
  body: unknown = { name: "test" },
): Promise<RoomJson> {
  const res = await fetch(`${ctx.http}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as RoomJson; // відповідь нашого ж API: форма перевіряється http-тестами
}

const toText = (data: RawData): string =>
  new TextDecoder().decode(Array.isArray(data) ? Buffer.concat(data) : data);

// Розбір кадру сервера в тестах: бінарні й JSON-кадри дають один тип.
function decodeFrame(data: RawData, isBinary: boolean): ServerMessage {
  if (isBinary) {
    const bytes = Array.isArray(data)
      ? Buffer.concat(data)
      : new Uint8Array(data);
    const msg = decodeBinary(bytes);
    if (msg.type === "input" || msg.type === "ping") {
      throw new Error(`сервер надіслав клієнтське повідомлення: ${msg.type}`);
    }
    return msg;
  }
  const msg = decodeServerJson(toText(data));
  if (!msg)
    throw new Error(`сервер надіслав некоректне повідомлення: ${toText(data)}`);
  return msg;
}

type Waiter = {
  type: ServerMessage["type"];
  resolve: (msg: ServerMessage) => void;
};

export interface TestClient {
  ws: WebSocket;
  inbox: ServerMessage[];
  closed: Promise<{ code: number; reason: string }>;
  opened: Promise<void>;
  send(msg: Record<string, unknown> & { type: ClientMessage["type"] }): void;
  next<K extends ServerMessage["type"]>(
    type: K,
    timeoutMs?: number,
  ): Promise<Extract<ServerMessage, { type: K }>>;
}

// Клієнт із чергою повідомлень: next(type) чекає на повідомлення потрібного типу.
export function connect(url: string, options?: object): TestClient {
  const ws = new WebSocket(url, undefined, options);
  const inbox: ServerMessage[] = [];
  const waiters: Waiter[] = [];

  const drain = (): void => {
    for (const waiter of [...waiters]) {
      const index = inbox.findIndex((m) => m.type === waiter.type);
      const found = inbox[index];
      if (index === -1 || !found) continue;
      inbox.splice(index, 1);
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(found);
    }
  };

  ws.on("message", (data: RawData, isBinary: boolean) => {
    inbox.push(decodeFrame(data, isBinary));
    drain();
  });
  ws.on("error", () => {}); // помилки тестового клієнта не мають валити тест

  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.on("close", (code: number, reason: Buffer) =>
      resolve({ code, reason: reason.toString() }),
    );
  });

  const opened = new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });

  return {
    ws,
    inbox,
    closed,
    opened,
    send: (msg) => ws.send(JSON.stringify({ v: 1, ...msg })),
    next<K extends ServerMessage["type"]>(type: K, timeoutMs = 1500) {
      return new Promise<Extract<ServerMessage, { type: K }>>(
        (resolve, reject) => {
          const waiter: Waiter = {
            type,
            // Єдине місце звуження: waiter викликається лише для повідомлень цього type.
            resolve: (msg) =>
              resolve(msg as Extract<ServerMessage, { type: K }>),
          };
          waiters.push(waiter);
          drain();
          setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index === -1) return;
            waiters.splice(index, 1);
            reject(new Error(`очікувалось повідомлення "${type}"`));
          }, timeoutMs).unref();
        },
      );
    },
  };
}

export async function joined(
  ctx: Pick<AppContext, "wsUrl">,
  roomId: string,
  name: string,
): Promise<TestClient> {
  const client = connect(ctx.wsUrl);
  await client.opened;
  client.send({ type: "join", room: roomId, name });
  await client.next("joined");
  return client;
}
