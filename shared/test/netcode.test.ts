import assert from "node:assert/strict";
import test from "node:test";
import { DT, TICK_MS } from "../src/constants.ts";
import {
  Predictor,
  ServerClock,
  SnapshotBuffer,
  lerpWrap,
  shortestDelta,
} from "../src/netcode/index.ts";
import { type EntityRecord, type Integrate, integrate, type ShipState } from "../src/sim/index.ts";
import { entityId } from "../src/types.ts";
import { advance, makeWorld, type ScriptedInput, scriptedInput } from "./helpers.ts";

const ARENA = { width: 1200, height: 800 };

// Запис сутності з розумними значеннями за замовчуванням: тест вказує лише
// те, що для нього важливо.
function rec(part: Partial<EntityRecord> = {}): EntityRecord {
  return {
    id: entityId(1),
    kind: 1,
    flags: 0,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    angle: 0,
    a: 0,
    b: 0,
    c: 0,
    ...part,
  };
}

// Мініатюрний «мережевий стенд»: справжній сервер-світ + Predictor, між ними
// черги з фіксованою затримкою в кроках. Затримка вимірюється в тиках.
function rig({
  latencyTicks = 3,
  clientIntegrate,
  steps = 120,
  dropEvery = 0,
}: {
  latencyTicks?: number;
  clientIntegrate?: Integrate;
  steps?: number;
  dropEvery?: number;
} = {}) {
  const { world, a: ship } = makeWorld(11, { asteroids: 0 });
  const predictor = new Predictor({ arena: ARENA, integrate: clientIntegrate });
  const upstream: { at: number; input: ScriptedInput }[] = []; // input на сервер
  const downstream: { at: number; rec: EntityRecord; ack: number }[] = []; // снапшоти до клієнта
  let acked = 0;
  const corrections: number[] = [];

  const first = world.snapshot().entities.find((e) => e.id === ship.id);
  assert.ok(first);
  predictor.reconcile(first, 0);

  for (let step = 0; step < steps; step++) {
    // клієнт: передбачає й відправляє input
    const { input } = predictor.step(scriptedInput(step));
    if (!(dropEvery && step % dropEvery === 0)) {
      upstream.push({ at: step + latencyTicks, input });
    }

    // сервер: приймає, що дійшло, рухає корабель
    let stepped = false;
    for (let next = upstream[0]; next && next.at <= step; next = upstream[0]) {
      upstream.shift();
      acked = next.input.seq;
      advance(world, new Map([[ship, next.input]]));
      stepped = true;
    }
    if (!stepped) advance(world);

    const own = world.snapshot().entities.find((e) => e.id === ship.id);
    assert.ok(own);
    downstream.push({ at: step + latencyTicks, rec: own, ack: acked });
    for (let next = downstream[0]; next && next.at <= step; next = downstream[0]) {
      downstream.shift();
      corrections.push(predictor.reconcile(next.rec, next.ack));
    }
  }
  return { corrections, predictor, ship, world };
}

test("реконсиляція: передбачення збігається із сервером (поправка ≈ 0)", () => {
  const { corrections } = rig({ latencyTicks: 3, steps: 150 });
  const max = Math.max(...corrections);
  assert.ok(max < 1e-3, `макс. поправка ${max}`);
});

test("реконсиляція: якщо клієнтський integrate недетермінований — поправки ростуть", () => {
  const noisy: Integrate = (s, i, dt, arena) => {
    const out = integrate(s, i, dt, arena);
    return { ...out, x: out.x + (Math.random() - 0.5) * 2 };
  };
  const clean = rig({ steps: 150 }).corrections;
  const broken = rig({ steps: 150, clientIntegrate: noisy }).corrections;
  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
  assert.ok(mean(broken) > mean(clean) * 100, `${mean(broken)} проти ${mean(clean)}`);
});

test("реконсиляція: втрата input дає поправку, але вона зникає", () => {
  const { corrections } = rig({ latencyTicks: 3, steps: 150, dropEvery: 10 });
  assert.ok(Math.max(...corrections) > 0.5, "втрачений input видно");
});

test("реконсиляція (розбір із завдання): снапшот tick 100 підтверджує seq 57, буфер 55–61", () => {
  const predictor = new Predictor({ arena: ARENA });
  const base = { x: 100, y: 100, vx: 0, vy: 0, angle: 0, cooldown: 0, rapid: false };
  predictor.state = { ...base, thrusting: false, dead: false };
  predictor.prev = predictor.state;
  predictor.pending = [55, 56, 57, 58, 59, 60, 61].map((seq) => ({
    seq,
    thrust: 1,
    turn: 0,
    fire: 0,
  }));

  const server = rec({ x: 150, y: 100, vx: 30 });
  predictor.reconcile(server, 57);

  assert.deepEqual(
    predictor.pending.map((p) => p.seq),
    [58, 59, 60, 61],
    "55–57 відкинуто, 58–61 лишилися",
  );
  // Стан = стан сервера + 4 перевідтворені input
  let expected: ShipState = { ...server, cooldown: 0, rapid: false };
  for (let i = 0; i < 4; i++) {
    expected = integrate(expected, { thrust: 1, turn: 0, fire: 0 }, DT, ARENA);
  }
  assert.equal(predictor.state?.x, expected.x);
  assert.equal(predictor.state?.vx, expected.vx);
});

test("поправка згладжується й затухає за ~100 мс; велика — не згладжується", () => {
  const predictor = new Predictor({ arena: ARENA, smoothingMs: 100 });
  const base = { x: 100, y: 100, vx: 0, vy: 0, angle: 0, cooldown: 0, rapid: false };
  predictor.state = { ...base, thrusting: false, dead: false };
  predictor.prev = predictor.state;
  predictor.reconcile(rec({ x: 110, y: 100 }), 0);
  assert.equal(predictor.lastCorrection, 10);
  assert.ok(Math.abs(predictor.offset.x - -10) < 1e-9, "малюємо там, де були");
  assert.equal(Math.round(predictor.renderState(1)?.x ?? NaN), 100);

  for (let i = 0; i < 6; i++) predictor.decay(1 / 60); // 100 мс
  assert.ok(Math.abs(predictor.offset.x) < 0.7, `залишилось ${predictor.offset.x}`);

  predictor.reconcile(rec({ x: 700, y: 100 }), 0);
  assert.deepEqual(predictor.offset, { x: 0, y: 0 }, "великий розрив — snap");
});

test("поправка рахується через шов тору", () => {
  const predictor = new Predictor({ arena: ARENA });
  predictor.state = {
    x: 1199,
    y: 100,
    vx: 0,
    vy: 0,
    angle: 0,
    cooldown: 0,
    rapid: false,
    thrusting: false,
    dead: false,
  };
  predictor.prev = predictor.state;
  predictor.reconcile(rec({ x: 1, y: 100 }), 0);
  assert.ok(Math.abs(predictor.lastCorrection - 2) < 1e-9);
});

test("передбачена куля: з'являється одразу, підтверджується серверною, зникає разом із нею", () => {
  const predictor = new Predictor({ arena: ARENA });
  predictor.reconcile(rec({ x: 300, y: 300 }), 0);
  const { bullet } = predictor.step({ thrust: 0, turn: 0, fire: 1 });
  assert.ok(bullet, "куля одразу");
  assert.equal(predictor.bullets.length, 1);

  // Снапшот ще не підтвердив (ack < seq): куля лишається.
  predictor.syncBullets([], 0, entityId(5));
  assert.equal(predictor.bullets.length, 1);

  // Сервер створив кулю з тим самим тегом.
  const serverBullet = rec({ id: entityId(40), kind: 2, c: 5, b: bullet.tag });
  let claimed = predictor.syncBullets([serverBullet], bullet.seq, entityId(5));
  assert.ok(claimed.has(entityId(40)), "серверну кулю малювати не треба");
  assert.equal(predictor.bullets[0]?.serverId, 40);

  // Сервер видалив кулю (влучання): локальна копія зникає.
  claimed = predictor.syncBullets([], bullet.seq + 1, entityId(5));
  assert.equal(predictor.bullets.length, 0);
});

test("передбачена куля, яку сервер не створив (cooldown/втрата), прибирається за ack", () => {
  const predictor = new Predictor({ arena: ARENA });
  predictor.reconcile(rec({ x: 300, y: 300 }), 0);
  const { bullet } = predictor.step({ thrust: 0, turn: 0, fire: 1 });
  assert.ok(bullet);
  predictor.syncBullets([], bullet.seq, entityId(5));
  assert.equal(predictor.bullets.length, 0);
});

test("SnapshotBuffer: інтерполяція між двома снапшотами", () => {
  const buf = new SnapshotBuffer();
  const e = (x: number): EntityRecord[] => [rec({ x, y: 10 })];
  buf.push({ tick: 10, ack: 0, entities: e(100) });
  buf.push({ tick: 12, ack: 0, entities: e(200) });
  const out = buf.sample(11, ARENA);
  assert.equal(out.mode, "interpolating");
  assert.equal(out.entities[0]?.x, 150);
  assert.equal(buf.sample(10.5, ARENA).entities[0]?.x, 125);
});

test("SnapshotBuffer: переупорядковані й дубльовані снапшоти", () => {
  const buf = new SnapshotBuffer();
  const mk = (tick: number) => ({ tick, ack: 0, entities: [] });
  assert.equal(buf.push(mk(12)), true);
  assert.equal(buf.push(mk(10)), true, "запізнілий вставляється на своє місце");
  assert.equal(buf.push(mk(12)), false, "дубль відкинуто");
  assert.deepEqual(buf.snaps.map((s) => s.tick), [10, 12]);
});

test("SnapshotBuffer: сутність, що з'являється/зникає між снапшотами", () => {
  const buf = new SnapshotBuffer();
  const bullet = (id: number, x: number): EntityRecord => rec({ id: entityId(id), kind: 2, x });
  buf.push({ tick: 10, ack: 0, entities: [bullet(1, 0)] });
  buf.push({ tick: 12, ack: 0, entities: [bullet(2, 50)] });

  const mid = buf.sample(11, ARENA);
  assert.deepEqual(mid.entities.map((e) => e.id), [1], "id 1 ще малюється, id 2 ще ні");

  const after = buf.sample(12, ARENA);
  assert.deepEqual(after.entities.map((e) => e.id), [2], "id 1 зник, id 2 з'явився");
});

test("SnapshotBuffer: інтерполяція через шов тору й екстраполяція", () => {
  const buf = new SnapshotBuffer();
  const at = (x: number, vx = 0): EntityRecord[] => [rec({ x, vx })];
  buf.push({ tick: 10, ack: 0, entities: at(1190) });
  buf.push({ tick: 12, ack: 0, entities: at(10) });
  const x = buf.sample(11, ARENA).entities[0]?.x ?? NaN;
  assert.ok(Math.abs(x - 0) < 1e-9 || Math.abs(x - 1200) < 1e-9, `x=${x}`);

  const ext = new SnapshotBuffer();
  ext.push({ tick: 10, ack: 0, entities: at(100, 30) });
  const out = ext.sample(12, ARENA);
  assert.equal(out.mode, "extrapolating");
  assert.ok(Math.abs((out.entities[0]?.x ?? NaN) - (100 + 30 * DT * 2)) < 1e-9);
  assert.ok((ext.sample(100, ARENA).entities[0]?.x ?? NaN) < 100 + 30 * DT * 5, "екстраполяція обмежена");
});

test("ServerClock: джитер не смикає годинник, мінімум задає базу", () => {
  const clock = new ServerClock({ gain: 1 });
  const base = 5000;
  for (let tick = 0; tick < 60; tick++) {
    const jitter = tick % 5 === 0 ? 0 : 20 + (tick % 3) * 5;
    clock.observe(tick, base + tick * TICK_MS + jitter);
  }
  assert.ok(Math.abs((clock.offset ?? NaN) - base) < 1e-6, `offset ${clock.offset}`);
  assert.ok(Math.abs(clock.serverTickAt(base + 30 * TICK_MS) - 30) < 1e-6);
});

test("геометрія тору", () => {
  assert.equal(shortestDelta(1190, 1200), -10);
  assert.equal(shortestDelta(-1190, 1200), 10);
  assert.ok(Math.abs(lerpWrap(1190, 10, 0.5, 1200) - 0) < 1e-9);
});
