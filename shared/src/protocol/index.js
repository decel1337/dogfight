// Протокол v1. Два класи повідомлень:
//
//  керування (завжди JSON, текстові кадри):
//    клієнт -> сервер  join {room, name, codec?}   chat {text}   net {latency, jitter, drop}
//    сервер -> клієнт  joined {you, room, ship, seed, tickRate, tick, arena, codec, netsim}
//                      roster {players}   chat {from, text, t}   error {message}
//
//  ігрові (кодек JSON або бінарний — обирається в join):
//    клієнт -> сервер  input {seq, tick, thrust, turn, fire}   ping {t}
//    сервер -> клієнт  snapshot {tick, ack, entities}   events {tick, events}
//                      pong {t, tick}
//
// Кожне JSON-повідомлення має поле `v` (версію) і `type`.
export const PROTOCOL_VERSION = 1;

// Коди закриття: 1000–1015 стандартні (RFC 6455), 4000–4999 — прикладні.
export const CLOSE = Object.freeze({
  NORMAL: 1000,
  GOING_AWAY: 1001,
  UNSUPPORTED: 1003,
  TOO_BIG: 1009,
  JOIN_TIMEOUT: 4001,
  INVALID_MESSAGE: 4002,
  RATE_LIMITED: 4003,
  ROOM_NOT_FOUND: 4004,
  ROOM_FULL: 4005,
  SLOW_CLIENT: 4006,
});

export const MAX_CHAT_LENGTH = 200;
export const ROOM_ID_RE = /^[\w-]{1,32}$/;
const NAME_RE = /^[\p{L}\p{N} _.-]{1,16}$/u;

export const CODECS = Object.freeze(["binary", "json"]);
export const DEFAULT_CODEC = "binary";

// Ігрові повідомлення, які клієнт може надсилати (для бінарного й JSON).
export const GAME_MESSAGES_UP = Object.freeze(["input", "ping"]);

const isObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isU32 = (value) =>
  Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const inRange = (value, min, max) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= min &&
  value <= max;

// input — найчастіше й найнебезпечніше повідомлення (turn: 1000 — це чит).
// Перевіряємо кожне поле й копіюємо лише відомі.
export function validateInput(msg) {
  if (!isU32(msg.seq)) return "input.seq: u32";
  if (!isU32(msg.tick)) return "input.tick: u32";
  if (msg.thrust !== 0 && msg.thrust !== 1) return "input.thrust: 0|1";
  if (msg.turn !== -1 && msg.turn !== 0 && msg.turn !== 1) {
    return "input.turn: -1|0|1";
  }
  if (msg.fire !== 0 && msg.fire !== 1 && msg.fire !== 2) {
    return "input.fire: 0|1|2";
  }
  return {
    type: "input",
    seq: msg.seq,
    tick: msg.tick,
    thrust: msg.thrust,
    turn: msg.turn,
    fire: msg.fire,
  };
}

const validators = {
  join(msg) {
    if (typeof msg.room !== "string" || !ROOM_ID_RE.test(msg.room)) {
      return "join.room: очікується ідентифікатор кімнати";
    }
    if (typeof msg.name !== "string") return "join.name: очікується рядок";
    const name = msg.name.trim();
    if (!NAME_RE.test(name)) return "join.name: 1–16 літер, цифр, пробіл _ . -";
    const codec = msg.codec ?? DEFAULT_CODEC;
    if (!CODECS.includes(codec)) return "join.codec: binary|json";
    return { type: "join", room: msg.room, name, codec };
  },

  chat(msg) {
    if (typeof msg.text !== "string") return "chat.text: очікується рядок";
    const text = msg.text.trim();
    if (text.length === 0 || text.length > MAX_CHAT_LENGTH) {
      return `chat.text: 1–${MAX_CHAT_LENGTH} символів`;
    }
    return { type: "chat", text };
  },

  input: validateInput,

  ping(msg) {
    if (!isU32(msg.t)) return "ping.t: u32";
    return { type: "ping", t: msg.t };
  },

  // Налаштування імітації мережі для ЦЬОГО з'єднання (латентність — RTT, мс).
  net(msg) {
    if (!inRange(msg.latency, 0, 2000)) return "net.latency: 0..2000";
    if (!inRange(msg.jitter, 0, 1000)) return "net.jitter: 0..1000";
    if (!inRange(msg.drop, 0, 100)) return "net.drop: 0..100 (%)";
    return {
      type: "net",
      latency: msg.latency,
      jitter: msg.jitter,
      drop: msg.drop,
    };
  },
};

const bad = (reason) => ({ ok: false, code: CLOSE.INVALID_MESSAGE, reason });

// Перевіряємо КОЖНЕ вхідне повідомлення: клієнт — це недовірене джерело,
// навіть якщо ми самі його написали (його можна підмінити чи обійти).
export function parseClientMessage(raw, { maxBytes }) {
  const bytes =
    typeof raw === "string" ? new TextEncoder().encode(raw).length : raw.length;
  if (bytes > maxBytes) {
    return { ok: false, code: CLOSE.TOO_BIG, reason: "повідомлення завелике" };
  }

  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return bad("некоректний JSON");
  }
  if (!isObject(msg)) return bad("очікується об'єкт");
  if (msg.v !== PROTOCOL_VERSION) {
    return bad(`непідтримувана версія протоколу: ${msg.v}`);
  }
  if (typeof msg.type !== "string" || !Object.hasOwn(validators, msg.type)) {
    return bad(`невідомий тип: ${String(msg.type).slice(0, 32)}`);
  }

  const result = validators[msg.type](msg);
  if (typeof result === "string") return bad(result);
  return { ok: true, msg: result };
}

// JSON-повідомлення сервера клієнту (керування й ігрові в json-режимі).
export function encode(type, payload = {}) {
  return JSON.stringify({ v: PROTOCOL_VERSION, type, ...payload });
}

// Розбір повідомлення сервера на клієнті. Сервера теж не довіряємо:
// null для всього, що не схоже на повідомлення протоколу.
export function decodeServerJson(raw) {
  try {
    const msg = JSON.parse(raw);
    if (!isObject(msg)) return null;
    if (msg.v !== PROTOCOL_VERSION || typeof msg.type !== "string") return null;
    return msg;
  } catch {
    return null;
  }
}
