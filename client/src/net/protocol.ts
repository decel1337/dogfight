// Протокол живе в @dogfight/shared: клієнт і сервер імпортують ОДНЕ й те саме,
// тож розбіжність версій чи розкладки неможлива фізично.
import { CodecError, decodeBinary } from "@dogfight/shared/codec";
import {
  CLOSE,
  type ClientMessage,
  decodeServerJson,
  encode,
  type GameMessage,
  PROTOCOL_VERSION,
  type ServerMessage,
} from "@dogfight/shared/protocol";
import { assertNever } from "@dogfight/shared/types";

export type { ClientMessage, ServerMessage };
export { CLOSE, encode, PROTOCOL_VERSION };

// Коди закриття, після яких перепідключення марне: повторний запит дасть
// ту саму відмову (некоректне повідомлення, немає кімнати, кімната повна).
export const FATAL_CLOSE_CODES: ReadonlySet<number> = new Set([
  CLOSE.INVALID_MESSAGE,
  CLOSE.ROOM_NOT_FOUND,
  CLOSE.ROOM_FULL,
  CLOSE.RATE_LIMITED,
]);

// Розбір кадру від сервера: текст — JSON (керування або json-кодек),
// ArrayBuffer/Uint8Array — бінарний кодек. null для всього, що не схоже на
// повідомлення протоколу. Недовірений вхід -> `unknown`, а не `any`.
export function decode(raw: unknown): ServerMessage | null {
  if (typeof raw === "string") return decodeServerJson(raw);
  if (!(raw instanceof ArrayBuffer || raw instanceof Uint8Array)) return null;
  let msg: GameMessage;
  try {
    msg = decodeBinary(raw);
  } catch (error: unknown) {
    if (error instanceof CodecError) return null;
    throw error;
  }
  // Сервер не шле input/ping: такі кадри — сміття.
  switch (msg.type) {
    case "snapshot":
    case "events":
    case "pong":
      return msg;
    case "input":
    case "ping":
      return null;
    default:
      return assertNever(msg, "бінарне повідомлення");
  }
}
