// Протокол v0 (дзеркало server/src/protocol.js). У Lab 6 типи стануть
// спільними; поки що константи дублюються свідомо — клієнт не імпортує сервер.
export const PROTOCOL_VERSION = 0;

// Коди закриття, після яких перепідключення марне: повторний запит дасть
// ту саму відмову (некоректне повідомлення, немає кімнати, кімната повна).
export const CLOSE = Object.freeze({
  NORMAL: 1000,
  INVALID_MESSAGE: 4002,
  ROOM_NOT_FOUND: 4004,
  ROOM_FULL: 4005,
});
export const FATAL_CLOSE_CODES = new Set([
  CLOSE.INVALID_MESSAGE,
  CLOSE.ROOM_NOT_FOUND,
  CLOSE.ROOM_FULL,
]);

export function encode(type, payload = {}) {
  return JSON.stringify({ v: PROTOCOL_VERSION, type, ...payload });
}

// Розбір вхідного повідомлення. Сервер теж недовіряємо: повертаємо null
// для всього, що не схоже на повідомлення протоколу.
export function decode(raw) {
  try {
    const msg = JSON.parse(raw);
    if (typeof msg !== "object" || msg === null) return null;
    if (msg.v !== PROTOCOL_VERSION || typeof msg.type !== "string") return null;
    return msg;
  } catch {
    return null;
  }
}
