import assert from "node:assert/strict";
import test from "node:test";
import {
  CLOSE,
  type ClientMessage,
  type CloseCode,
  type ParseResult,
  decodeServerJson,
  encode,
  parseClientMessage,
} from "@dogfight/shared/protocol";

const parse = (value: unknown, maxBytes = 2048): ParseResult<ClientMessage> =>
  parseClientMessage(typeof value === "string" ? value : JSON.stringify(value), { maxBytes });

// Звуження union: після виклику result гарантовано відмова з кодом.
function expectRejected(result: ParseResult<unknown>, code: CloseCode): void {
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, code);
}

test("protocol: коректні join і chat", () => {
  const join = parse({ v: 1, type: "join", room: "r-1", name: "  Ace " });
  assert.deepEqual(join, { ok: true, msg: { type: "join", room: "r-1", name: "Ace", codec: "binary" } });
  assert.deepEqual(parse({ v: 1, type: "chat", text: " hi " }), {
    ok: true,
    msg: { type: "chat", text: "hi" },
  });
});

test("protocol: відхиляє зламану форму з кодом 4002", () => {
  const cases = [
    "not json",
    "[]",
    "null",
    JSON.stringify({ type: "chat", text: "x" }), // без версії
    { v: 0, type: "chat", text: "x" }, // чужа версія
    { v: 1, type: "teleport" }, // невідомий тип
    { v: 1, type: "join", room: "../etc", name: "Ace" },
    { v: 1, type: "join", room: "r-1", name: "" },
    { v: 1, type: "join", room: "r-1", name: "x".repeat(17) },
    { v: 1, type: "join", room: "r-1", name: "<script>" },
    { v: 1, type: "chat", text: "" },
    { v: 1, type: "chat", text: "x".repeat(201) },
    { v: 1, type: "chat", text: 42 },
  ];
  for (const input of cases) {
    expectRejected(parse(input), CLOSE.INVALID_MESSAGE);
  }
});

test("protocol: ключі прототипу не вважаються типами повідомлень", () => {
  for (const type of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    assert.equal(parse({ v: 1, type }).ok, false, type);
  }
});

test("protocol: завеликий розмір -> 1009 ще до розбору JSON", () => {
  expectRejected(parse("x".repeat(3000), 2048), CLOSE.TOO_BIG);
});

test("protocol: розмір рахується в байтах, а не символах", () => {
  const text = "я".repeat(60); // 120 байт у UTF-8
  expectRejected(parse(JSON.stringify({ v: 1, type: "chat", text }), 100), CLOSE.TOO_BIG);
});

test("protocol: encode додає версію і тип", () => {
  assert.deepEqual(JSON.parse(encode({ type: "roster", players: [] })), {
    v: 1,
    type: "roster",
    players: [],
  });
});

test("protocol: input — кожне поле перевіряється (turn: 1000 — це чит)", () => {
  const ok = { v: 1, type: "input", seq: 1, tick: 5, thrust: 1, turn: -1, fire: 2 };
  assert.equal(parse(ok).ok, true);
  const bads = [
    { turn: 1000 },
    { turn: 2 },
    { thrust: 2 },
    { thrust: true },
    { fire: 3 },
    { seq: -1 },
    { seq: 1.5 },
    { seq: 2 ** 32 },
    { tick: "5" },
  ];
  for (const patch of bads) {
    expectRejected(parse({ ...ok, ...patch }), CLOSE.INVALID_MESSAGE);
  }
});

test("protocol: net має межі, join.codec — лише відомі", () => {
  assert.equal(parse({ v: 1, type: "net", latency: 200, jitter: 50, drop: 5 }).ok, true);
  assert.equal(parse({ v: 1, type: "net", latency: 99999, jitter: 0, drop: 0 }).ok, false);
  assert.equal(parse({ v: 1, type: "net", latency: 1, jitter: 0, drop: 101 }).ok, false);
  assert.equal(parse({ v: 1, type: "join", room: "r", name: "A", codec: "xml" }).ok, false);
  assert.equal(parse({ v: 1, type: "join", room: "r", name: "A", codec: "json" }).ok, true);
});

test("protocol: сервер теж валідується (decodeServerJson)", () => {
  const good = encode({ type: "pong", t: 5, tick: 9 });
  assert.deepEqual(decodeServerJson(good), { type: "pong", t: 5, tick: 9 });
  assert.equal(decodeServerJson(JSON.stringify({ v: 1, type: "pong", t: "x", tick: 9 })), null);
  assert.equal(decodeServerJson(JSON.stringify({ v: 2, type: "pong", t: 1, tick: 9 })), null);
  assert.equal(decodeServerJson("{"), null);
});

test("protocol: клієнт не може надіслати серверне повідомлення", () => {
  expectRejected(parse({ v: 1, type: "joined" }), CLOSE.INVALID_MESSAGE);
  expectRejected(parse({ v: 1, type: "snapshot", tick: 1, ack: 0, entities: [] }), CLOSE.INVALID_MESSAGE);
});
