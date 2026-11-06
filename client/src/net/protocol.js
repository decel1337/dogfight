// Протокол живе в @dogfight/shared: клієнт і сервер імпортують ОДНЕ й те саме,
// тож розбіжність версій чи розкладки неможлива фізично.
import { decodeBinary } from "@dogfight/shared/codec";
import {
  CLOSE,
  PROTOCOL_VERSION,
  decodeServerJson,
  encode,
} from "@dogfight/shared/protocol";

export { CLOSE, PROTOCOL_VERSION, encode };

// Коди закриття, після яких перепідключення марне: повторний запит дасть
// ту саму відмову (некоректне повідомлення, немає кімнати, кімната повна).
export const FATAL_CLOSE_CODES = new Set([
  CLOSE.INVALID_MESSAGE,
  CLOSE.ROOM_NOT_FOUND,
  CLOSE.ROOM_FULL,
  CLOSE.RATE_LIMITED,
]);

// Розбір кадру від сервера: текст — JSON (керування або json-кодек),
// ArrayBuffer — бінарний кодек. null для всього, що не схоже на протокол.
export function decode(raw) {
  if (typeof raw === "string") return decodeServerJson(raw);
  try {
    return decodeBinary(raw);
  } catch {
    return null;
  }
}
