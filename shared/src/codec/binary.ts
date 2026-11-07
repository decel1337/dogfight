// БІНАРНИЙ ПРОТОКОЛ v1 (специфікація)
// ====================================
// Порядок байтів: LITTLE-ENDIAN скрізь (кожен DataView-виклик має `true`).
// Транспорт: бінарні кадри WebSocket. Кожне повідомлення починається з:
//
//   байт 0    біти 7..4 = версія формату (зараз 1), біти 3..0 = тип повідомлення
//   байти 1–4 u32 — основне число повідомлення (див. нижче), майже завжди tick
//
// Типи (біти 3..0 байта 0):
//   1 INPUT    клієнт -> сервер, 10 байт
//   2 PING     клієнт -> сервер,  5 байт
//   3 SNAPSHOT сервер -> клієнт, 11 + 26·N байт
//   4 EVENTS   сервер -> клієнт,  6 + 11·M байт
//   5 PONG     сервер -> клієнт,  9 байт
//
// INPUT:
//   [0]    версія|1
//   [1–4]  u32 tick   — оцінка клієнтом поточного тику сервера
//   [5–8]  u32 seq    — номер input (зростає на 1 за крок симуляції)
//   [9]    u8 упаковані керування: біт0 thrust (0|1),
//                                  біти1–2 turn+1 (0..2 ⇒ -1..1),
//                                  біти3–4 fire (0..2)
//
// PING:      [0] версія|2   [1–4] u32 t — час клієнта, мс (по модулю 2³²)
//
// SNAPSHOT:
//   [0]     версія|3
//   [1–4]   u32 tick
//   [5–8]   u32 ack   — seq останнього input ЦЬОГО клієнта, який сервер обробив
//   [9–10]  u16 N     — кількість сутностей
//   далі N записів по 26 байт (зсув усередині запису):
//     0  u16 id
//     2  u8  kind     (1 корабель, 2 куля, 3 астероїд, 4 бонус)
//     3  u8  flags    (корабель: 1 тяга, 2 щит, 4 мертвий, 8 невразливий, 16 бонус;
//                      куля/астероїд: 1 самонавідний)
//     4  f32 x
//     8  f32 y
//     12 f32 vx
//     16 f32 vy
//     20 i16 angle    — у 1/1000 радіана, діапазон ±π ⇒ ±3142
//     22 u8  a        (корабель: hp; астероїд: радіус; бонус: тип)
//     23 u8  b        (корабель: перезарядка або, якщо мертвий, кроки до респавну;
//                      куля: тег = молодші 8 біт seq пострілу)
//     24 u16 c        (корабель: рахунок; куля: id власника)
//
// EVENTS:
//   [0]    версія|4
//   [1–4]  u32 tick
//   [5]    u8 M — кількість подій (≤ 255)
//   далі M записів по 11 байт: u8 kind (1 fired, 2 hit, 3 exploded),
//   u16 id, f32 x, f32 y
//
// PONG:      [0] версія|5   [1–4] u32 tick сервера   [5–8] u32 t — ехо з PING
//
// Версію можна збільшити, коли змінюється розкладка; декодер відхиляє чужу.
//
// Декодер ВАЛІДУЄ: версія, довжина, дозволені значення kind/turn/fire,
// нульові зарезервовані біти. Некоректний кадр — CodecError, а не «якось
// розібране» повідомлення з числами поза діапазоном.

import { assertNever, entityId } from "../types.ts";
import type { KindCode } from "../sim/entity.ts";
import type {
  EventsMessage,
  GameEvent,
  GameMessage,
  InputMessage,
  PingMessage,
  PongMessage,
  SnapshotMessage,
} from "../protocol/index.ts";

export const FORMAT_VERSION = 1;

export const MSG = { INPUT: 1, PING: 2, SNAPSHOT: 3, EVENTS: 4, PONG: 5 } as const;

export const RECORD_SIZE = 26;
export const SNAPSHOT_HEADER = 11;
export const EVENT_SIZE = 11;
export const EVENTS_HEADER = 6;
export const INPUT_SIZE = 10;

// Кут зберігаємо в 1/1000 радіана: крок 0.001 рад ≈ 0.057°, тобто на відстані
// 1000 px від повороту це ≈ 1 px. Кут використовується лише для малювання й
// початкового стану реконсиляції, тож цього досить (див. README).
export const ANGLE_SCALE = 1000;

export class CodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodecError";
  }
}

const header = (type: number): number => (FORMAT_VERSION << 4) | type;
const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

function view(data: ArrayBuffer | Uint8Array): DataView {
  if (data instanceof ArrayBuffer) return new DataView(data);
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

export function encodeInput(msg: InputMessage): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(INPUT_SIZE);
  const v = new DataView(out.buffer);
  v.setUint8(0, header(MSG.INPUT));
  v.setUint32(1, msg.tick, true);
  v.setUint32(5, msg.seq, true);
  v.setUint8(9, msg.thrust | ((msg.turn + 1) << 1) | (msg.fire << 3));
  return out;
}

export function encodePing(msg: Pick<PingMessage, "t">): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(5);
  const v = new DataView(out.buffer);
  v.setUint8(0, header(MSG.PING));
  v.setUint32(1, msg.t >>> 0, true);
  return out;
}

export function encodeSnapshot(msg: SnapshotMessage): Uint8Array<ArrayBuffer> {
  const n = msg.entities.length;
  const out = new Uint8Array(SNAPSHOT_HEADER + n * RECORD_SIZE);
  const v = new DataView(out.buffer);
  v.setUint8(0, header(MSG.SNAPSHOT));
  v.setUint32(1, msg.tick, true);
  v.setUint32(5, msg.ack, true);
  v.setUint16(9, n, true);

  let o = SNAPSHOT_HEADER;
  for (const e of msg.entities) {
    v.setUint16(o, e.id, true);
    v.setUint8(o + 2, e.kind);
    v.setUint8(o + 3, e.flags);
    v.setFloat32(o + 4, e.x, true);
    v.setFloat32(o + 8, e.y, true);
    v.setFloat32(o + 12, e.vx, true);
    v.setFloat32(o + 16, e.vy, true);
    v.setInt16(o + 20, Math.round(e.angle * ANGLE_SCALE), true);
    v.setUint8(o + 22, clamp(e.a, 0, 255));
    v.setUint8(o + 23, clamp(e.b, 0, 255));
    v.setUint16(o + 24, clamp(e.c, 0, 0xffff), true);
    o += RECORD_SIZE;
  }
  return out;
}

export function encodeEvents(msg: EventsMessage): Uint8Array<ArrayBuffer> {
  const m = Math.min(msg.events.length, 255);
  const out = new Uint8Array(EVENTS_HEADER + m * EVENT_SIZE);
  const v = new DataView(out.buffer);
  v.setUint8(0, header(MSG.EVENTS));
  v.setUint32(1, msg.tick, true);
  v.setUint8(5, m);
  let o = EVENTS_HEADER;
  for (const e of msg.events.slice(0, m)) {
    v.setUint8(o, e.kind);
    v.setUint16(o + 1, e.id, true);
    v.setFloat32(o + 3, e.x, true);
    v.setFloat32(o + 7, e.y, true);
    o += EVENT_SIZE;
  }
  return out;
}

export function encodePong(msg: PongMessage): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(9);
  const v = new DataView(out.buffer);
  v.setUint8(0, header(MSG.PONG));
  v.setUint32(1, msg.tick, true);
  v.setUint32(5, msg.t >>> 0, true);
  return out;
}

// Вичерпний switch: новий варіант GameMessage без кодека не скомпілюється.
export function encodeBinary(msg: GameMessage): Uint8Array<ArrayBuffer> {
  switch (msg.type) {
    case "input":
      return encodeInput(msg);
    case "ping":
      return encodePing(msg);
    case "snapshot":
      return encodeSnapshot(msg);
    case "events":
      return encodeEvents(msg);
    case "pong":
      return encodePong(msg);
    default:
      return assertNever(msg, "тип повідомлення");
  }
}

function expectLength(actual: number, expected: number, what: string): void {
  if (actual !== expected) {
    throw new CodecError(`${what}: довжина ${actual}, очікувалось ${expected}`);
  }
}

// Звуження «число з кадру» -> літеральний тип. Кожна функція відхиляє
// значення поза словником: так з байтів не «просочується» turn = 3.
function turnOf(code: number): -1 | 0 | 1 {
  if (code === 0) return -1;
  if (code === 1) return 0;
  if (code === 2) return 1;
  throw new CodecError(`input.turn: некоректний код ${code}`);
}

function fireOf(code: number): 0 | 1 | 2 {
  if (code === 0 || code === 1 || code === 2) return code;
  throw new CodecError(`input.fire: некоректний код ${code}`);
}

function kindOf(code: number): KindCode {
  if (code === 1 || code === 2 || code === 3 || code === 4) return code;
  throw new CodecError(`невідомий вид сутності: ${code}`);
}

function eventKindOf(code: number): GameEvent["kind"] {
  if (code === 1 || code === 2 || code === 3) return code;
  throw new CodecError(`невідомий вид події: ${code}`);
}

export function decodeBinary(data: ArrayBuffer | Uint8Array): GameMessage {
  const v = view(data);
  const length = v.byteLength;
  if (length < 5) throw new CodecError("кадр закороткий");

  const first = v.getUint8(0);
  const version = first >> 4;
  if (version !== FORMAT_VERSION) {
    throw new CodecError(`непідтримувана версія формату: ${version}`);
  }

  switch (first & 0x0f) {
    case MSG.INPUT: {
      expectLength(length, INPUT_SIZE, "input");
      const packed = v.getUint8(9);
      // біти 5–7 мають бути нулями; інакше кадр підроблений
      if (packed >> 5 !== 0) throw new CodecError("input: зарезервовані біти");
      return {
        type: "input",
        tick: v.getUint32(1, true),
        seq: v.getUint32(5, true),
        thrust: (packed & 1) === 1 ? 1 : 0,
        turn: turnOf((packed >> 1) & 3),
        fire: fireOf((packed >> 3) & 3),
      };
    }
    case MSG.PING:
      expectLength(length, 5, "ping");
      return { type: "ping", t: v.getUint32(1, true) };

    case MSG.SNAPSHOT: {
      if (length < SNAPSHOT_HEADER) throw new CodecError("snapshot закороткий");
      const n = v.getUint16(9, true);
      expectLength(length, SNAPSHOT_HEADER + n * RECORD_SIZE, "snapshot");
      const entities: SnapshotMessage["entities"][number][] = [];
      let o = SNAPSHOT_HEADER;
      for (let i = 0; i < n; i++) {
        entities.push({
          id: entityId(v.getUint16(o, true)),
          kind: kindOf(v.getUint8(o + 2)),
          flags: v.getUint8(o + 3),
          x: v.getFloat32(o + 4, true),
          y: v.getFloat32(o + 8, true),
          vx: v.getFloat32(o + 12, true),
          vy: v.getFloat32(o + 16, true),
          angle: v.getInt16(o + 20, true) / ANGLE_SCALE,
          a: v.getUint8(o + 22),
          b: v.getUint8(o + 23),
          c: v.getUint16(o + 24, true),
        });
        o += RECORD_SIZE;
      }
      return {
        type: "snapshot",
        tick: v.getUint32(1, true),
        ack: v.getUint32(5, true),
        entities,
      };
    }
    case MSG.EVENTS: {
      if (length < EVENTS_HEADER) throw new CodecError("events закороткий");
      const m = v.getUint8(5);
      expectLength(length, EVENTS_HEADER + m * EVENT_SIZE, "events");
      const events: GameEvent[] = [];
      let o = EVENTS_HEADER;
      for (let i = 0; i < m; i++) {
        events.push({
          kind: eventKindOf(v.getUint8(o)),
          id: entityId(v.getUint16(o + 1, true)),
          x: v.getFloat32(o + 3, true),
          y: v.getFloat32(o + 7, true),
        });
        o += EVENT_SIZE;
      }
      return { type: "events", tick: v.getUint32(1, true), events };
    }
    case MSG.PONG:
      expectLength(length, 9, "pong");
      return {
        type: "pong",
        tick: v.getUint32(1, true),
        t: v.getUint32(5, true),
      };
    default:
      throw new CodecError(`невідомий тип повідомлення: ${first & 0x0f}`);
  }
}
