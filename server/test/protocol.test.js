import assert from "node:assert/strict";
import test from "node:test";
import { CLOSE, encode, parseClientMessage } from "../src/protocol.js";

const parse = (value, maxBytes = 2048) =>
  parseClientMessage(
    typeof value === "string" ? value : JSON.stringify(value),
    { maxBytes },
  );

test("protocol: коректні join і chat", () => {
  const join = parse({ v: 0, type: "join", room: "r-1", name: "  Ace " });
  assert.deepEqual(join, {
    ok: true,
    msg: { type: "join", room: "r-1", name: "Ace" },
  });
  assert.deepEqual(parse({ v: 0, type: "chat", text: " hi " }), {
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
    { v: 1, type: "chat", text: "x" }, // чужа версія
    { v: 0, type: "teleport" }, // невідомий тип
    { v: 0, type: "join", room: "../etc", name: "Ace" },
    { v: 0, type: "join", room: "r-1", name: "" },
    { v: 0, type: "join", room: "r-1", name: "x".repeat(17) },
    { v: 0, type: "join", room: "r-1", name: "<script>" },
    { v: 0, type: "chat", text: "" },
    { v: 0, type: "chat", text: "x".repeat(201) },
    { v: 0, type: "chat", text: 42 },
  ];
  for (const input of cases) {
    const result = parse(input);
    assert.equal(result.ok, false, JSON.stringify(input));
    assert.equal(result.code, CLOSE.INVALID_MESSAGE);
  }
});

test("protocol: ключі прототипу не вважаються типами повідомлень", () => {
  for (const type of [
    "__proto__",
    "constructor",
    "toString",
    "hasOwnProperty",
  ]) {
    assert.equal(parse({ v: 0, type }).ok, false, type);
  }
});

test("protocol: завеликий розмір -> 1009 ще до розбору JSON", () => {
  const result = parse("x".repeat(3000), 2048);
  assert.equal(result.ok, false);
  assert.equal(result.code, CLOSE.TOO_BIG);
});

test("protocol: розмір рахується в байтах, а не символах", () => {
  const text = "я".repeat(60); // 120 байт у UTF-8
  assert.equal(
    parse(JSON.stringify({ v: 0, type: "chat", text }), 100).code,
    CLOSE.TOO_BIG,
  );
});

test("protocol: encode додає версію і тип", () => {
  assert.deepEqual(JSON.parse(encode("roster", { players: [] })), {
    v: 0,
    type: "roster",
    players: [],
  });
});
