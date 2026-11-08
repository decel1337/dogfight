import assert from "node:assert/strict";
import { test } from "vitest";
import {
  type ConnectionOptions,
  type SocketLike,
  createConnection,
} from "../src/net/connection.ts";
import { decode, encode } from "../src/net/protocol.ts";

// Надіслані клієнтом кадри в тесті: JSON-об'єкти (або сирі байти sendGame).
type Sent = Record<string, unknown>;

class FakeSocket implements SocketLike {
  static instances: FakeSocket[] = [];
  binaryType = "blob";
  readyState = 0;
  bufferedAmount = 0;
  sent: Sent[] = [];
  raw: (string | Uint8Array)[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  send(data: string | Uint8Array): void {
    this.raw.push(data);
    if (typeof data === "string") this.sent.push(JSON.parse(data));
  }
  close(code = 1000): void {
    this.readyState = 3;
    this.onclose?.({ code, reason: "" });
  }
  // --- помічники тесту ---
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(msg: string | Record<string, unknown>): void {
    this.onmessage?.({ data: typeof msg === "string" ? msg : JSON.stringify({ v: 1, ...msg }) });
  }
  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code, reason: "" });
  }
}

interface FakeTimer {
  fn: () => void;
  ms: number;
  cleared: boolean;
}

function setup(overrides: Partial<ConnectionOptions> = {}) {
  FakeSocket.instances = [];
  const timers: FakeTimer[] = [];
  const conn = createConnection({
    url: "ws://test/ws",
    WebSocketImpl: FakeSocket,
    random: () => 1, // максимальний jitter: затримка = стеля
    // Таймери в тесті — індекси масиву; тип TimerHandle сумісний через приведення
    // лише тут (справжній setTimeout повертає інший тип).
    setTimer: (fn, ms) => timers.push({ fn, ms, cleared: false }) - 1 as unknown as ReturnType<typeof setTimeout>,
    clearTimer: (id) => {
      const timer = timers[id as unknown as number];
      if (timer) timer.cleared = true;
    },
    ...overrides,
  });
  const socket = (): FakeSocket => {
    const last = FakeSocket.instances.at(-1);
    if (!last) throw new Error("сокет ще не створено");
    return last;
  };
  const fire = (index: number): void => {
    const timer = timers[index];
    if (timer && !timer.cleared) timer.fn();
  };
  const lastMs = (): number | undefined => timers.at(-1)?.ms;
  return { conn, timers, socket, fire, lastMs };
}

test("protocol: encode/decode та відхилення сміття від сервера", () => {
  assert.deepEqual(decode(encode({ type: "pong", t: 1, tick: 2 })), { type: "pong", t: 1, tick: 2 });
  // Клієнтське повідомлення — не повідомлення сервера: відхиляється.
  assert.equal(decode(encode({ type: "chat", text: "x" })), null);
  for (const junk of ["", "x", "null", "[]", '{"type":"chat"}', '{"v":9,"type":"x"}', '{"v":1}', "\u0000"]) {
    assert.equal(decode(junk), null, junk);
  }
});

test("черга: повідомлення до open не губляться й ідуть у порядку", () => {
  const { conn, socket } = setup();
  conn.connect();
  conn.send({ type: "chat", text: "1" });
  conn.send({ type: "chat", text: "2" });
  assert.equal(conn.queued, 2);

  socket().open();
  assert.deepEqual(socket().sent.map((m) => m["text"]), ["1", "2"]);
  assert.equal(conn.queued, 0);
});

test("open-обробник відправляє join РАНІШЕ за накопичену чергу", () => {
  const { conn, socket } = setup();
  conn.on("open", () => conn.send({ type: "join", room: "r", name: "A", codec: "binary" }));
  conn.connect();
  conn.send({ type: "chat", text: "queued" });
  socket().open();
  assert.deepEqual(socket().sent.map((m) => m.type), ["join", "chat"]);
});

test("диспетчер: обробники викликаються за type, відписка працює", () => {
  const { conn, socket } = setup();
  const seen: string[] = [];
  const off = conn.on("chat", (m) => seen.push(m.text));
  conn.on("roster", (m) => seen.push(`roster:${m.players.length}`));
  conn.connect();
  socket().open();

  socket().receive({ type: "chat", from: "A", fromId: 1, text: "hi", t: 0 });
  socket().receive({
    type: "roster",
    players: [
      { id: 1, name: "A" },
      { id: 2, name: "B" },
    ],
  });
  off();
  socket().receive({ type: "chat", from: "A", fromId: 1, text: "ignored", t: 0 });
  assert.deepEqual(seen, ["hi", "roster:2"]);
});

test("сміття від сервера не ламає клієнта (подія bad-message)", () => {
  const { conn, socket } = setup();
  const bad: unknown[] = [];
  conn.on("bad-message", (raw) => bad.push(raw));
  conn.connect();
  socket().open();
  socket().receive("not json");
  socket().receive({ type: 5 });
  assert.equal(bad.length, 2);
});

test("reconnect: експоненційний backoff зі стелею, скидання після успіху", () => {
  const { conn, timers, socket, fire, lastMs } = setup({ backoff: { baseMs: 500, factor: 2, maxMs: 3000 } });
  const attempts: { attempt: number; delayMs: number }[] = [];
  conn.on("reconnecting", (info) => attempts.push(info));
  conn.connect();
  socket().open();

  const delays: (number | undefined)[] = [];
  for (let i = 0; i < 5; i++) {
    socket().drop();
    delays.push(lastMs());
    fire(timers.length - 1);
  }
  assert.deepEqual(delays, [500, 1000, 2000, 3000, 3000], "стеля maxMs");
  assert.deepEqual(attempts.map((a) => a.attempt), [1, 2, 3, 4, 5]);

  socket().open(); // успішне підключення
  socket().drop();
  assert.equal(lastMs(), 500, "після успіху backoff починається спочатку");
});

test("reconnect: jitter розкидає затримки в [0, стеля]", () => {
  const { conn, lastMs, socket } = setup({ random: () => 0.25 });
  conn.connect();
  socket().open();
  socket().drop();
  assert.equal(lastMs(), 125); // 0.25 * 500
});

test("reconnect не відбувається після close() користувача", () => {
  const { conn, timers, socket } = setup();
  const closes: { willRetry: boolean }[] = [];
  conn.on("close", (info) => closes.push(info));
  conn.connect();
  socket().open();
  conn.close();
  assert.equal(timers.length, 0);
  assert.equal(closes[0]?.willRetry, false);
});

test("reconnect не відбувається після фатальних кодів 4002/4004/4005", () => {
  for (const code of [4002, 4004, 4005]) {
    const { conn, timers, socket } = setup();
    const closes: { willRetry: boolean }[] = [];
    conn.on("close", (info) => closes.push(info));
    conn.connect();
    socket().open();
    socket().drop(code);
    assert.equal(timers.length, 0, `код ${code}`);
    assert.equal(closes[0]?.willRetry, false);
  }
});

test("під час розриву повідомлення стають у чергу й доходять після reconnect", () => {
  const { conn, timers, socket, fire } = setup();
  conn.on("open", () => conn.send({ type: "join", room: "r", name: "A", codec: "binary" }));
  conn.connect();
  socket().open();
  socket().drop();

  conn.send({ type: "chat", text: "офлайн" });
  assert.equal(conn.queued, 1);
  fire(timers.length - 1);
  socket().open();
  assert.deepEqual(socket().sent.map((m) => m.type), ["join", "chat"]);
});

test("некритичні повідомлення пропускаються при розриві та при затору", () => {
  const { conn, socket } = setup({ bufferedLimit: 100 });
  const dropped: string[] = [];
  conn.on("dropped", (info) => dropped.push(info.reason));
  conn.connect();

  assert.equal(conn.send({ type: "ping", t: 1 }, { critical: false }), false);
  socket().open();
  assert.equal(conn.send({ type: "ping", t: 2 }, { critical: false }), true);

  socket().bufferedAmount = 5000;
  assert.equal(conn.send({ type: "ping", t: 3 }, { critical: false }), false);
  assert.equal(conn.send({ type: "chat", text: "важливе" }), true, "критичні йдуть завжди");
  assert.deepEqual(dropped, ["offline", "buffered"]);
});

test("черга обмежена: найстаріше витісняється", () => {
  const { conn, socket } = setup({ maxQueue: 3 });
  const dropped: string[] = [];
  conn.on("dropped", (info) => dropped.push(info.reason));
  conn.connect();
  for (let i = 1; i <= 5; i++) conn.send({ type: "chat", text: String(i) });
  assert.equal(conn.queued, 3);
  socket().open();
  assert.deepEqual(socket().sent.map((m) => m["text"]), ["3", "4", "5"]);
  assert.equal(dropped.length, 2);
});

test("бінарні кадри розбираються кодеком, лічильники байтів ростуть", async () => {
  const { encodeBinary } = await import("@dogfight/shared/codec");
  const { conn, socket } = setup();
  const seen: unknown[] = [];
  conn.on("pong", (m) => seen.push(m));
  conn.connect();
  socket().open();
  assert.equal(socket().binaryType, "arraybuffer");

  const frame = encodeBinary({ type: "pong", tick: 42, t: 7 });
  socket().onmessage?.({ data: frame.buffer });
  assert.deepEqual(seen, [{ type: "pong", tick: 42, t: 7 }]);
  assert.equal(conn.stats.bytesIn, frame.byteLength);
});

test("sendGame: не ставиться в чергу й пропускається при затору", () => {
  const { conn, socket } = setup({ bufferedLimit: 100 });
  conn.connect();
  assert.equal(conn.sendGame(new Uint8Array(10)), false, "офлайн — відкинуто");
  socket().open();
  assert.equal(conn.sendGame(new Uint8Array(10)), true);
  socket().bufferedAmount = 500;
  assert.equal(conn.sendGame(new Uint8Array(10)), false);
  assert.equal(conn.queued, 0);
  assert.equal(conn.stats.bytesOut, 10);
  assert.equal(socket().raw.length, 1, "лише один кадр дійшов до сокета");
});
