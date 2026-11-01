// Протокол v0: JSON-повідомлення з обов'язковим полем версії `v` і `type`.
//
// клієнт -> сервер:  join {room, name}   chat {text}
// сервер -> клієнт:  joined {you, room}  roster {players}  chat {from, text, t}
//                    error {message}
export const PROTOCOL_VERSION = 0;

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

const isObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const validators = {
  join(msg) {
    if (typeof msg.room !== "string" || !ROOM_ID_RE.test(msg.room)) {
      return "join.room: очікується ідентифікатор кімнати";
    }
    if (typeof msg.name !== "string") return "join.name: очікується рядок";
    const name = msg.name.trim();
    if (!NAME_RE.test(name)) return "join.name: 1–16 літер, цифр, пробіл _ . -";
    return { type: "join", room: msg.room, name };
  },

  chat(msg) {
    if (typeof msg.text !== "string") return "chat.text: очікується рядок";
    const text = msg.text.trim();
    if (text.length === 0 || text.length > MAX_CHAT_LENGTH) {
      return `chat.text: 1–${MAX_CHAT_LENGTH} символів`;
    }
    return { type: "chat", text };
  },
};

// Перевіряємо КОЖНЕ вхідне повідомлення: клієнт — це недовірене джерело,
// навіть якщо ми самі його написали (його можна підмінити чи обійти).
const bad = (reason) => ({ ok: false, code: CLOSE.INVALID_MESSAGE, reason });

export function parseClientMessage(raw, { maxBytes }) {
  const bytes = typeof raw === "string" ? Buffer.byteLength(raw) : raw.length;
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

export function encode(type, payload = {}) {
  return JSON.stringify({ v: PROTOCOL_VERSION, type, ...payload });
}
