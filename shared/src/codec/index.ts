import {
  CLOSE,
  type ClientGameMessage,
  type CodecName,
  type GameMessage,
  type ParseResult,
} from "../protocol/index.ts";
import { CodecError, decodeBinary, encodeBinary } from "./binary.ts";
import { decodeJson, encodeJson } from "./json.ts";

export * from "./binary.ts";
export { decodeJson, encodeJson } from "./json.ts";

// Єдиний інтерфейс: binary і json дають однакові об'єкти-повідомлення, тож
// решта коду від кодека не залежить. encode повертає Uint8Array (бінарний
// кадр) або string (текстовий кадр); decode ВАЛІДУЄ й кидає CodecError.
export interface Codec {
  readonly name: CodecName;
  readonly binary: boolean;
  encode(msg: GameMessage): Uint8Array<ArrayBuffer> | string;
  decode(frame: ArrayBuffer | Uint8Array | string): GameMessage;
}

const binaryCodec: Codec = {
  name: "binary",
  binary: true,
  encode: encodeBinary,
  decode(frame) {
    if (typeof frame === "string")
      throw new CodecError("очікувався бінарний кадр");
    return decodeBinary(frame);
  },
};

const jsonCodec: Codec = {
  name: "json",
  binary: false,
  encode: encodeJson,
  decode(frame) {
    if (typeof frame !== "string")
      throw new CodecError("очікувався текстовий кадр");
    return decodeJson(frame);
  },
};

export const CODEC_BY_NAME: { readonly [name in CodecName]: Codec } = {
  binary: binaryCodec,
  json: jsonCodec,
};

export function getCodec(name: CodecName): Codec {
  return CODEC_BY_NAME[name];
}

// Розбір бінарного кадру від КЛІЄНТА: розмір, форма й діапазони перевіряє
// сам декодер; тут лише відсікаємо повідомлення, які клієнт не має права
// надсилати (snapshot, events, pong).
export function parseClientBinary(
  data: ArrayBuffer | Uint8Array,
  { maxBytes }: { maxBytes: number },
): ParseResult<ClientGameMessage> {
  if (data.byteLength > maxBytes) {
    return { ok: false, code: CLOSE.TOO_BIG, reason: "повідомлення завелике" };
  }
  let msg: GameMessage;
  try {
    msg = decodeBinary(data);
  } catch (error: unknown) {
    if (!(error instanceof CodecError)) throw error;
    return { ok: false, code: CLOSE.INVALID_MESSAGE, reason: error.message };
  }
  switch (msg.type) {
    case "input":
    case "ping":
      return { ok: true, msg };
    case "snapshot":
    case "events":
    case "pong":
      return {
        ok: false,
        code: CLOSE.INVALID_MESSAGE,
        reason: `клієнт не може надсилати ${msg.type}`,
      };
  }
}
