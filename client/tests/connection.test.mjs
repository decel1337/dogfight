import assert from "node:assert/strict";
import test from "node:test";
import { createConnection } from "../src/net/connection.js";
import { PROTOCOL_VERSION, decode, encode } from "../src/net/protocol.js";

class FakeSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.bufferedAmount = 0;
    FakeSocket.instances.push(this);
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000) {
    this.readyState = 3;
    this.onclose?.({ code, reason: "" });
  }
  // --- помічники тесту ---
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(msg) {
    this.onmessage?.({
      data: typeof msg === "string" ? msg : JSON.stringify({ v: 0, ...msg }),
    });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code, reason: "" });
  }
}

function setup(overrides = {}) {
  FakeSocket.instances = [];
  const timers = [];
  const conn = createConnection({
    url: "ws://test/ws",
    WebSocketImpl: FakeSocket,
    random: () => 1, // максимальний jitter: затримка = стеля
    setTimer: (fn, ms) => timers.push({ fn, ms, cleared: false }) - 1,
    clearTimer: (id) => {
      if (id !== null && timers[id]) timers[id].cleared = true;
    },
    ...overrides,
  });
  const socket = () => FakeSocket.instances.at(-1);
  const fire = (index) => {
    if (!timers[index].cleared) timers[index].fn();
  };
  return { conn, timers, socket, fire };
}

test("protocol: encode/decode та відхилення сміття від сервера", () => {
  assert.deepEqual(decode(encode("chat", { text: "x" })), {
    v: PROTOCOL_VERSION,
    type: "chat",
    text: "x",
  });
  for (const junk of [
    "",
    "x",
    "null",
    "[]",
    '{"type":"chat"}',
    '{"v":9,"type":"x"}',
    '{"v":0}',
  ]) {
    assert.equal(decode(junk), null, junk);
  }
});

test("черга: повідомлення до open не губляться й ідуть у порядку", () => {
  const { conn, socket } = setup();
  conn.connect();
  conn.send("chat", { text: "1" });
  conn.send("chat", { text: "2" });
  assert.equal(conn.queued, 2);

  socket().open();
  assert.deepEqual(
    socket().sent.map((m) => m.text),
    ["1", "2"],
  );
  assert.equal(conn.queued, 0);
});

test("open-обробник відправляє join РАНІШЕ за накопичену чергу", () => {
  const { conn, socket } = setup();
  conn.on("open", () => conn.send("join", { room: "r", name: "A" }));
  conn.connect();
  conn.send("chat", { text: "queued" });
  socket().open();
  assert.deepEqual(
    socket().sent.map((m) => m.type),
    ["join", "chat"],
  );
});

test("диспетчер: обробники викликаються за type, відписка працює", () => {
  const { conn, socket } = setup();
  const seen = [];
  const off = conn.on("chat", (m) => seen.push(m.text));
  conn.on("roster", (m) => seen.push(`roster:${m.players.length}`));
  conn.connect();
  socket().open();

  socket().receive({ type: "chat", text: "hi" });
  socket().receive({ type: "roster", players: [1, 2] });
  off();
  socket().receive({ type: "chat", text: "ignored" });
  assert.deepEqual(seen, ["hi", "roster:2"]);
});

test("сміття від сервера не ламає клієнта (подія bad-message)", () => {
  const { conn, socket } = setup();
  const bad = [];
  conn.on("bad-message", (raw) => bad.push(raw));
  conn.connect();
  socket().open();
  socket().receive("not json");
  socket().receive({ type: 5 });
  assert.equal(bad.length, 2);
});

test("reconnect: експоненційний backoff зі стелею, скидання після успіху", () => {
  const { conn, timers, socket, fire } = setup({
    backoff: { baseMs: 500, factor: 2, maxMs: 3000 },
  });
  const attempts = [];
  conn.on("reconnecting", (info) => attempts.push(info));
  conn.connect();
  socket().open();

  const delays = [];
  for (let i = 0; i < 5; i++) {
    socket().drop();
    delays.push(timers.at(-1).ms);
    fire(timers.length - 1);
  }
  assert.deepEqual(delays, [500, 1000, 2000, 3000, 3000], "стеля maxMs");
  assert.deepEqual(
    attempts.map((a) => a.attempt),
    [1, 2, 3, 4, 5],
  );

  socket().open(); // успішне підключення
  socket().drop();
  assert.equal(
    timers.at(-1).ms,
    500,
    "після успіху backoff починається спочатку",
  );
});

test("reconnect: jitter розкидає затримки в [0, стеля]", () => {
  const { conn, timers, socket } = setup({ random: () => 0.25 });
  conn.connect();
  socket().open();
  socket().drop();
  assert.equal(timers.at(-1).ms, 125); // 0.25 * 500
});

test("reconnect не відбувається після close() користувача", () => {
  const { conn, timers, socket } = setup();
  const closes = [];
  conn.on("close", (info) => closes.push(info));
  conn.connect();
  socket().open();
  conn.close();
  assert.equal(timers.length, 0);
  assert.equal(closes[0].willRetry, false);
});

test("reconnect не відбувається після фатальних кодів 4002/4004/4005", () => {
  for (const code of [4002, 4004, 4005]) {
    const { conn, timers, socket } = setup();
    const closes = [];
    conn.on("close", (info) => closes.push(info));
    conn.connect();
    socket().open();
    socket().drop(code);
    assert.equal(timers.length, 0, `код ${code}`);
    assert.equal(closes[0].willRetry, false);
  }
});

test("під час розриву повідомлення стають у чергу й доходять після reconnect", () => {
  const { conn, timers, socket, fire } = setup();
  conn.on("open", () => conn.send("join", { room: "r", name: "A" }));
  conn.connect();
  socket().open();
  socket().drop();

  conn.send("chat", { text: "офлайн" });
  assert.equal(conn.queued, 1);
  fire(timers.length - 1);
  socket().open();
  assert.deepEqual(
    socket().sent.map((m) => m.type),
    ["join", "chat"],
  );
});

test("некритичні повідомлення пропускаються при розриві та при затору", () => {
  const { conn, socket } = setup({ bufferedLimit: 100 });
  const dropped = [];
  conn.on("dropped", (info) => dropped.push(info.reason));
  conn.connect();

  assert.equal(conn.send("move", { x: 1 }, { critical: false }), false);
  socket().open();
  assert.equal(conn.send("move", { x: 2 }, { critical: false }), true);

  socket().bufferedAmount = 5000;
  assert.equal(conn.send("move", { x: 3 }, { critical: false }), false);
  assert.equal(
    conn.send("chat", { text: "важливе" }),
    true,
    "критичні йдуть завжди",
  );
  assert.deepEqual(dropped, ["offline", "buffered"]);
});

test("черга обмежена: найстаріше витісняється", () => {
  const { conn, socket } = setup({ maxQueue: 3 });
  const dropped = [];
  conn.on("dropped", (info) => dropped.push(info.reason));
  conn.connect();
  for (let i = 1; i <= 5; i++) conn.send("chat", { text: String(i) });
  assert.equal(conn.queued, 3);
  socket().open();
  assert.deepEqual(
    socket().sent.map((m) => m.text),
    ["3", "4", "5"],
  );
  assert.equal(dropped.length, 2);
});
