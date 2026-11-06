import { PROTOCOL_VERSION } from "../protocol/index.js";

// JSON-кодек: ті самі повідомлення, текстовий запис. Лишається за прапорцем
// (join.codec = "json"), щоб було з чим порівнювати.
//
// Для чесного порівняння числа округлюємо так, як зробив би розумний
// розробник: 2 знаки для позицій і швидкостей, 3 для кута. Без цього JSON
// друкував би по 15–17 цифр (дивись README) і порівняння було б нечесним.
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

function roundedRecord(e) {
  return {
    id: e.id,
    kind: e.kind,
    flags: e.flags,
    x: r2(e.x),
    y: r2(e.y),
    vx: r2(e.vx),
    vy: r2(e.vy),
    angle: r3(e.angle),
    a: e.a,
    b: e.b,
    c: e.c,
  };
}

export function encodeJson(msg) {
  const body =
    msg.type === "snapshot"
      ? { ...msg, entities: msg.entities.map(roundedRecord) }
      : msg;
  return JSON.stringify({ v: PROTOCOL_VERSION, ...body });
}

// Декодування повідомлення сервера (клієнтська сторона). Повертає null,
// якщо це не схоже на повідомлення протоколу.
export function decodeJson(text) {
  try {
    const msg = JSON.parse(text);
    if (typeof msg !== "object" || msg === null) return null;
    if (msg.v !== PROTOCOL_VERSION || typeof msg.type !== "string") return null;
    return msg;
  } catch {
    return null;
  }
}
