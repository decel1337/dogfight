import { describe, expect, test } from "vitest";
import { DT } from "../src/constants.ts";
import { Predictor } from "../src/netcode/index.ts";
import { type Controls, type EntityRecord, integrate } from "../src/sim/index.ts";
import { entityId } from "../src/types.ts";

const ARENA = { width: 1200, height: 800 };
const GO: Controls = { thrust: 1, turn: 0, fire: 0 };

const record = (over: Partial<EntityRecord> = {}): EntityRecord => ({
  id: entityId(1), kind: 1, flags: 0, x: 600, y: 400, vx: 0, vy: 0, angle: 0, a: 3, b: 0, c: 0, ...over,
});

// Реконсиляція — детермінована функція (серверний запис, ack, черга input) -> стан:
// перевіряємо її як чисту, порівнюючи з ручним переграванням через integrate.
function replayByHand(rec: EntityRecord, inputs: Controls[]) {
  let state = { x: rec.x, y: rec.y, vx: rec.vx, vy: rec.vy, angle: rec.angle, cooldown: 0, rapid: false };
  for (const input of inputs) state = { ...integrate(state, input, DT, ARENA) };
  return state;
}

describe("Predictor.reconcile", () => {
  test("без розбіжності поправка нульова, а передбачення збігається з сервером", () => {
    const p = new Predictor({ arena: ARENA });
    p.reconcile(record(), 0);
    for (let i = 0; i < 5; i++) p.step(GO);
    // Сервер підтверджує 3 input, виконавши їх так само, як клієнт.
    const server = replayByHand(record(), [GO, GO, GO]);
    const correction = p.reconcile(record({ x: server.x, y: server.y, vx: server.vx, vy: server.vy }), 3);
    expect(correction).toBeCloseTo(0, 9);
  });

  test("підтверджені input видаляються з черги, непідтверджені перегравються", () => {
    const p = new Predictor({ arena: ARENA });
    p.reconcile(record(), 0);
    for (let i = 0; i < 6; i++) p.step(GO);
    p.reconcile(record(), 4);
    expect(p.pending.map((i) => i.seq)).toEqual([5, 6]);
    const expected = replayByHand(record(), [GO, GO]);
    expect(p.state?.x).toBeCloseTo(expected.x, 9);
    expect(p.state?.vx).toBeCloseTo(expected.vx, 9);
  });

  test("розбіжність сервера дає поправку рівно в її розмір", () => {
    const p = new Predictor({ arena: ARENA });
    p.reconcile(record(), 0);
    for (let i = 0; i < 3; i++) p.step(GO);
    const before = p.state?.x ?? 0;
    // Сервер «каже», що корабель на 10 px лівіше за стартову позицію.
    const correction = p.reconcile(record({ x: 590 }), 3);
    const after = p.state?.x ?? 0;
    expect(correction).toBeGreaterThan(5);
    expect(Math.abs(before - after)).toBeCloseTo(correction, 6);
  });

  test("великий розрив: згладжування вимикається (snap)", () => {
    const p = new Predictor({ arena: ARENA });
    p.reconcile(record(), 0);
    p.step(GO);
    p.reconcile(record({ x: 100 }), 1);
    expect(p.offset).toEqual({ x: 0, y: 0 });
  });

  test("decay: поправка експоненційно згасає до нуля", () => {
    const p = new Predictor({ arena: ARENA });
    p.reconcile(record(), 0);
    p.step(GO);
    p.reconcile(record({ x: 595 }), 1);
    const start = Math.abs(p.offset.x);
    for (let i = 0; i < 60; i++) p.decay(1 / 60);
    expect(Math.abs(p.offset.x)).toBeLessThan(start * 0.1);
  });
});
