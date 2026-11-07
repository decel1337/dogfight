import { z } from "zod";
import {
  EventsSchema,
  type GameMessage,
  InputSchema,
  PingSchema,
  PongSchema,
  PROTOCOL_VERSION,
  type SnapshotMessage,
  SnapshotSchema,
} from "../protocol/index.ts";
import { CodecError } from "./binary.ts";

// JSON-кодек: ті самі повідомлення, текстовий запис. Лишається за прапорцем
// (join.codec = "json"), щоб було з чим порівнювати.
//
// Для чесного порівняння числа округлюємо так, як зробив би розумний
// розробник: 2 знаки для позицій і швидкостей, 3 для кута. Без цього JSON
// друкував би по 15–17 цифр (дивись README) і порівняння було б нечесним.
const r2 = (v: number): number => Math.round(v * 100) / 100;
const r3 = (v: number): number => Math.round(v * 1000) / 1000;

type Record = SnapshotMessage["entities"][number];

function roundedRecord(e: Record): Record {
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

export function encodeJson(msg: GameMessage): string {
  const body =
    msg.type === "snapshot"
      ? { ...msg, entities: msg.entities.map(roundedRecord) }
      : msg;
  return JSON.stringify({ v: PROTOCOL_VERSION, ...body });
}

const GameMessageSchema = z.discriminatedUnion("type", [
  InputSchema,
  PingSchema,
  SnapshotSchema,
  EventsSchema,
  PongSchema,
]);

// Декодування ігрового повідомлення з тими самими перевірками діапазонів,
// що й бінарне: помилка — CodecError, а не «напіврозібраний» об'єкт.
export function decodeJson(text: string): GameMessage {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CodecError("некоректний JSON");
  }
  const parsed = GameMessageSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new CodecError(issue ? `${issue.path.join(".")}: ${issue.message}` : "некоректне повідомлення");
  }
  return parsed.data;
}
