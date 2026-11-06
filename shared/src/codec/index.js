import { CLOSE, validateInput } from "../protocol/index.js";
import { CodecError, decodeBinary, encodeBinary } from "./binary.js";
import { decodeJson, encodeJson } from "./json.js";

export * from "./binary.js";
export { decodeJson, encodeJson } from "./json.js";

// Єдиний інтерфейс: binary і json дають однакові об'єкти-повідомлення, тож
// решта коду від кодека не залежить. encode повертає Uint8Array (бінарний
// кадр) або string (текстовий кадр).
export const CODEC_BY_NAME = Object.freeze({
  binary: {
    name: "binary",
    binary: true,
    encode: encodeBinary,
    decode: decodeBinary,
  },
  json: {
    name: "json",
    binary: false,
    encode: encodeJson,
    decode: decodeJson,
  },
});

export function getCodec(name) {
  const codec = CODEC_BY_NAME[name];
  if (!codec) throw new Error(`невідомий кодек: ${name}`);
  return codec;
}

// Розбір бінарного кадру від КЛІЄНТА з тими самими гарантіями, що й у
// parseClientMessage: розмір, форма, діапазони. Повертає {ok, msg|code,reason}.
export function parseClientBinary(data, { maxBytes }) {
  if (data.byteLength > maxBytes) {
    return { ok: false, code: CLOSE.TOO_BIG, reason: "повідомлення завелике" };
  }

  let msg;
  try {
    msg = decodeBinary(data);
  } catch (error) {
    if (!(error instanceof CodecError)) throw error;
    return { ok: false, code: CLOSE.INVALID_MESSAGE, reason: error.message };
  }

  if (msg.type === "input") {
    if (msg.reserved !== 0) {
      return {
        ok: false,
        code: CLOSE.INVALID_MESSAGE,
        reason: "input: reserved",
      };
    }
    const checked = validateInput(msg);
    if (typeof checked === "string") {
      return { ok: false, code: CLOSE.INVALID_MESSAGE, reason: checked };
    }
    return { ok: true, msg: checked };
  }
  if (msg.type === "ping") return { ok: true, msg };
  return {
    ok: false,
    code: CLOSE.INVALID_MESSAGE,
    reason: `клієнт не може надсилати ${msg.type}`,
  };
}
