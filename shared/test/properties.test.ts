import { seqNo as asSeq, tick as asTick } from "@dogfight/shared/types";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  CodecError,
  decodeBinary,
  EVENT_SIZE,
  EVENTS_HEADER,
  encodeBinary,
  encodeInput,
  encodeSnapshot,
  INPUT_SIZE,
  parseClientBinary,
  RECORD_SIZE,
  SNAPSHOT_HEADER,
  withAck,
} from "../src/codec/index.ts";
import { DT } from "../src/constants.ts";
import {
  encode,
  type InputMessage,
  parseClientMessage,
} from "../src/protocol/index.ts";
import type { EntityRecord } from "../src/sim/index.ts";
import { integrate, normalizeAngle } from "../src/sim/index.ts";
import { entityId } from "../src/types.ts";

// ---------- генератори (arbitraries) ----------

const u32 = fc.integer({ min: 0, max: 0xffffffff });
const bit = fc.constantFrom(0 as const, 1 as const);
const turn = fc.constantFrom(-1 as const, 0 as const, 1 as const);
const fire = fc.constantFrom(0 as const, 1 as const, 2 as const);

const inputArb: fc.Arbitrary<InputMessage> = fc.record({
  type: fc.constant("input" as const),
  seq: u32,
  tick: u32,
  thrust: bit,
  turn,
  fire,
});

const ARENA = { width: 1200, height: 800 };
const coord = (max: number) =>
  fc
    .double({ min: 0, max, noNaN: true, noDefaultInfinity: true })
    .filter((v) => v < max);
const speed = fc.double({
  min: -600,
  max: 600,
  noNaN: true,
  noDefaultInfinity: true,
});

const recordArb: fc.Arbitrary<EntityRecord> = fc.record({
  id: fc.integer({ min: 0, max: 0xffff }).map(entityId),
  kind: fc.constantFrom(1 as const, 2 as const, 3 as const, 4 as const),
  flags: fc.integer({ min: 0, max: 255 }),
  x: coord(ARENA.width),
  y: coord(ARENA.height),
  vx: speed,
  vy: speed,
  angle: fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
  a: fc.integer({ min: 0, max: 100 }),
  b: fc.integer({ min: 0, max: 255 }),
  c: fc.integer({ min: 0, max: 255 }),
});

const shipStateArb = fc.record({
  x: coord(ARENA.width),
  y: coord(ARENA.height),
  vx: speed,
  vy: speed,
  angle: fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
  cooldown: fc.integer({ min: 0, max: 30 }),
  rapid: fc.boolean(),
});

const controlsArb = fc.record({ thrust: bit, turn, fire });

// ---------- властивості ----------

describe("властивості кодека", () => {
  test("round-trip: decode(encode(input)) === input для будь-якого коректного input", () => {
    fc.assert(
      fc.property(inputArb, (msg) => {
        expect(decodeBinary(encodeInput(msg))).toEqual(msg);
      }),
    );
  });

  test("довжина кадру визначається лише типом і кількістю записів", () => {
    fc.assert(
      fc.property(
        inputArb,
        fc.array(recordArb, { maxLength: 40 }),
        (input, entities) => {
          expect(encodeBinary(input).byteLength).toBe(INPUT_SIZE);
          const snapshot = encodeBinary({
            type: "snapshot",
            tick: asTick(1),
            ack: asSeq(2),
            entities,
          });
          expect(snapshot.byteLength).toBe(
            SNAPSHOT_HEADER + entities.length * RECORD_SIZE,
          );
          const events = entities.map((e) => ({
            kind: 1 as const,
            id: e.id,
            x: e.x,
            y: e.y,
          }));
          expect(
            encodeBinary({ type: "events", tick: asTick(1), events })
              .byteLength,
          ).toBe(EVENTS_HEADER + events.length * EVENT_SIZE);
        },
      ),
    );
  });

  test("снапшот після квантування стабільний: encode∘decode∘encode == encode", () => {
    fc.assert(
      fc.property(fc.array(recordArb, { maxLength: 20 }), (entities) => {
        const once = encodeBinary({
          type: "snapshot",
          tick: asTick(7),
          ack: asSeq(3),
          entities,
        });
        const twice = encodeBinary(decodeBinary(once));
        expect(Array.from(twice)).toEqual(Array.from(once));
      }),
    );
  });

  test("безпека до сміття: довільні байти дають повідомлення або CodecError, але не інший виняток", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), (bytes) => {
        try {
          decodeBinary(bytes);
        } catch (error) {
          expect(error).toBeInstanceOf(CodecError);
        }
        // клієнтський розбір взагалі не кидає: повертає ParseResult
        const result = parseClientBinary(bytes, { maxBytes: 64 });
        expect(typeof result.ok).toBe("boolean");
      }),
      { numRuns: 500 },
    );
  });
});

describe("властивості JSON-парсера", () => {
  test("прийняття: будь-яке коректне повідомлення клієнта проходить parseClientMessage без змін", () => {
    fc.assert(
      fc.property(inputArb, (msg) => {
        const result = parseClientMessage(encode(msg), { maxBytes: 4096 });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.msg).toEqual(msg);
      }),
    );
  });

  test("відхилення: turn поза {-1,0,1} завжди відкидається", () => {
    fc.assert(
      fc.property(
        inputArb,
        fc
          .integer({ min: -1_000_000, max: 1_000_000 })
          .filter((n) => n < -1 || n > 1),
        (msg, badTurn) => {
          const raw = JSON.stringify({ ...msg, v: 1, turn: badTurn });
          expect(parseClientMessage(raw, { maxBytes: 4096 }).ok).toBe(false);
        },
      ),
    );
  });

  test("безпека до сміття: довільний рядок чи JSON ніколи не кидає виняток", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.json()), (raw) => {
        const result = parseClientMessage(raw, { maxBytes: 256 });
        expect(typeof result.ok).toBe("boolean");
      }),
      { numRuns: 500 },
    );
  });
});

describe("властивості симуляції", () => {
  test("рух по тору: з будь-якого стану й керування корабель лишається в арені", () => {
    fc.assert(
      fc.property(
        shipStateArb,
        fc.array(controlsArb, { minLength: 1, maxLength: 60 }),
        (start, inputs) => {
          let state = start;
          for (const input of inputs) {
            state = { ...integrate(state, input, DT, ARENA) };
            expect(state.x).toBeGreaterThanOrEqual(0);
            expect(state.x).toBeLessThan(ARENA.width);
            expect(state.y).toBeGreaterThanOrEqual(0);
            expect(state.y).toBeLessThan(ARENA.height);
            expect(Number.isFinite(state.vx) && Number.isFinite(state.vy)).toBe(
              true,
            );
          }
        },
      ),
    );
  });

  test("integrate чиста: однаковий вхід -> однаковий вихід", () => {
    fc.assert(
      fc.property(shipStateArb, controlsArb, (state, input) => {
        expect(integrate(state, input, DT, ARENA)).toEqual(
          integrate(state, input, DT, ARENA),
        );
      }),
    );
  });

  test("normalizeAngle: результат у [-π, π] і еквівалентний за sin/cos", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1000, max: 1000, noNaN: true }),
        (angle) => {
          const n = normalizeAngle(angle);
          expect(Math.abs(n)).toBeLessThanOrEqual(Math.PI + 1e-9);
          expect(Math.sin(n)).toBeCloseTo(Math.sin(angle), 6);
          expect(Math.cos(n)).toBeCloseTo(Math.cos(angle), 6);
        },
      ),
    );
  });
});

test("property: withAck(encode(ack=0), a) == encode(ack=a) для будь-яких снапшотів", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 0xffffffff }),
      fc.integer({ min: 0, max: 0xffffffff }),
      fc.array(
        fc.record({
          id: fc.integer({ min: 1, max: 0xffff }),
          kind: fc.constantFrom(1, 2, 3, 4),
          flags: fc.integer({ min: 0, max: 255 }),
          x: fc.float({ noNaN: true, noDefaultInfinity: true }),
          y: fc.float({ noNaN: true, noDefaultInfinity: true }),
          vx: fc.float({ noNaN: true, noDefaultInfinity: true }),
          vy: fc.float({ noNaN: true, noDefaultInfinity: true }),
          angle: fc.double({ min: -3, max: 3, noNaN: true }),
          a: fc.integer({ min: 0, max: 255 }),
          b: fc.integer({ min: 0, max: 255 }),
          c: fc.integer({ min: 0, max: 0xffff }),
        }),
        { maxLength: 20 },
      ),
      (tick, ack, entities) => {
        const base = encodeSnapshot({
          type: "snapshot",
          tick,
          ack: 0,
          entities,
        } as never);
        const direct = encodeSnapshot({
          type: "snapshot",
          tick,
          ack,
          entities,
        } as never);
        const patched = withAck(base, ack);
        expect(patched).toEqual(direct);
        expect(base[5]).toBe(0); // базовий буфер не змінюється
      },
    ),
  );
});
