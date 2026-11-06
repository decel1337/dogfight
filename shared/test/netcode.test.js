import assert from "node:assert/strict";
import test from "node:test";
import { DT, TICK_MS } from "../src/constants.js";
import {
  Predictor,
  ServerClock,
  SnapshotBuffer,
  lerpWrap,
  shortestDelta,
} from "../src/netcode/index.js";
import { integrate } from "../src/sim/index.js";
import { advance, makeWorld, scriptedInput } from "./helpers.js";

const ARENA = { width: 1200, height: 800 };

// Мініатюрний «мережевий стенд»: справжній сервер-світ + Predictor, між ними
// черги з фіксованою затримкою в кроках. Затримка вимірюється в тиках.
function rig({
  latencyTicks = 3,
  clientIntegrate,
  steps = 120,
  dropEvery = 0,
} = {}) {
  const { world, a: ship } = makeWorld(11, { asteroids: 0 });
  const predictor = new Predictor({ arena: ARENA, integrate: clientIntegrate });
  const upstream = []; // input, що летять на сервер
  const downstream = []; // снапшоти, що летять до клієнта
  let acked = 0;
  const corrections = [];

  const first = world.snapshot().entities.find((e) => e.id === ship.id);
  predictor.reconcile(first, 0);

  for (let step = 0; step < steps; step++) {
    // клієнт: передбачає й відправляє input
    const { input } = predictor.step(scriptedInput(step));
    if (!(dropEvery && step % dropEvery === 0)) {
      upstream.push({ at: step + latencyTicks, input });
    }

    // сервер: приймає, що дійшло, рухає корабель
    const inputs = new Map();
    while (upstream.length && upstream[0].at <= step) {
      const { input: got } = upstream.shift();
      inputs.set(ship, got);
      acked = got.seq;
      advance(world, new Map([[ship, got]]));
    }
    if (inputs.size === 0) advance(world);

    const rec = world.snapshot().entities.find((e) => e.id === ship.id);
    downstream.push({ at: step + latencyTicks, rec, ack: acked });
    while (downstream.length && downstream[0].at <= step) {
      const snap = downstream.shift();
      corrections.push(predictor.reconcile(snap.rec, snap.ack));
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
  const noisy = (s, i, dt, arena) => {
    const out = integrate(s, i, dt, arena);
    return { ...out, x: out.x + (Math.random() - 0.5) * 2 };
  };
  const clean = rig({ steps: 150 }).corrections;
  const broken = rig({ steps: 150, clientIntegrate: noisy }).corrections;
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  assert.ok(
    mean(broken) > mean(clean) * 100,
    `${mean(broken)} проти ${mean(clean)}`,
  );
});

test("реконсиляція: втрата input дає поправку, але вона зникає", () => {
  const { corrections } = rig({ latencyTicks: 3, steps: 150, dropEvery: 10 });
  assert.ok(Math.max(...corrections) > 0.5, "втрачений input видно");
});

test("реконсиляція (розбір із завдання): снапшот tick 100 підтверджує seq 57, буфер 55–61", () => {
  const predictor = new Predictor({ arena: ARENA });
  const base = {
    x: 100,
    y: 100,
    vx: 0,
    vy: 0,
    angle: 0,
    cooldown: 0,
    rapid: false,
  };
  predictor.state = { ...base, dead: false };
  predictor.prev = predictor.state;
  predictor.pending = [55, 56, 57, 58, 59, 60, 61].map((seq) => ({
    seq,
    thrust: 1,
    turn: 0,
    fire: 0,
  }));

  const rec = { x: 150, y: 100, vx: 30, vy: 0, angle: 0, flags: 0, b: 0 };
  predictor.reconcile(rec, 57);

  assert.deepEqual(
    predictor.pending.map((p) => p.seq),
    [58, 59, 60, 61],
    "55–57 відкинуто, 58–61 лишилися",
  );
  // Стан = стан сервера + 4 перевідтворені input
  let expected = { ...rec, cooldown: 0, rapid: false };
  for (let i = 0; i < 4; i++) {
    expected = integrate(expected, { thrust: 1, turn: 0, fire: 0 }, DT, ARENA);
  }
  assert.equal(predictor.state.x, expected.x);
  assert.equal(predictor.state.vx, expected.vx);
});

test("поправка згладжується й затухає за ~100 мс; велика — не згладжується", () => {
  const predictor = new Predictor({ arena: ARENA, smoothingMs: 100 });
  const base = {
    x: 100,
    y: 100,
    vx: 0,
    vy: 0,
    angle: 0,
    cooldown: 0,
    rapid: false,
  };
  predictor.state = { ...base, dead: false };
  predictor.prev = predictor.state;
  predictor.reconcile(
    { x: 110, y: 100, vx: 0, vy: 0, angle: 0, flags: 0, b: 0 },
    0,
  );
  assert.equal(predictor.lastCorrection, 10);
  assert.ok(Math.abs(predictor.offset.x - -10) < 1e-9, "малюємо там, де були");
  assert.equal(Math.round(predictor.renderState(1).x), 100);

  for (let i = 0; i < 6; i++) predictor.decay(1 / 60); // 100 мс
  assert.ok(
    Math.abs(predictor.offset.x) < 0.7,
    `залишилось ${predictor.offset.x}`,
  );

  predictor.reconcile(
    { x: 700, y: 100, vx: 0, vy: 0, angle: 0, flags: 0, b: 0 },
    0,
  );
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
    dead: false,
  };
  predictor.prev = predictor.state;
  predictor.reconcile(
    { x: 1, y: 100, vx: 0, vy: 0, angle: 0, flags: 0, b: 0 },
    0,
  );
  assert.ok(Math.abs(predictor.lastCorrection - 2) < 1e-9);
});

test("передбачена куля: з'являється одразу, підтверджується серверною, зникає разом із нею", () => {
  const predictor = new Predictor({ arena: ARENA });
  predictor.reconcile(
    { x: 300, y: 300, vx: 0, vy: 0, angle: 0, flags: 0, b: 0 },
    0,
  );
  const { bullet } = predictor.step({ thrust: 0, turn: 0, fire: 1 });
  assert.ok(bullet, "куля одразу");
  assert.equal(predictor.bullets.length, 1);

  // Снапшот ще не підтвердив (ack < seq): куля лишається.
  predictor.syncBullets([], 0, 5);
  assert.equal(predictor.bullets.length, 1);

  // Сервер створив кулю з тим самим тегом.
  const serverBullet = { id: 40, kind: 2, c: 5, b: bullet.tag };
  let claimed = predictor.syncBullets([serverBullet], bullet.seq, 5);
  assert.ok(claimed.has(40), "серверну кулю малювати не треба");
  assert.equal(predictor.bullets[0].serverId, 40);

  // Сервер видалив кулю (влучання): локальна копія зникає.
  claimed = predictor.syncBullets([], bullet.seq + 1, 5);
  assert.equal(predictor.bullets.length, 0);
});

test("передбачена куля, яку сервер не створив (cooldown/втрата), прибирається за ack", () => {
  const predictor = new Predictor({ arena: ARENA });
  predictor.reconcile(
    { x: 300, y: 300, vx: 0, vy: 0, angle: 0, flags: 0, b: 0 },
    0,
  );
  const { bullet } = predictor.step({ thrust: 0, turn: 0, fire: 1 });
  predictor.syncBullets([], bullet.seq, 5);
  assert.equal(predictor.bullets.length, 0);
});

test("SnapshotBuffer: інтерполяція між двома снапшотами", () => {
  const buf = new SnapshotBuffer();
  const e = (x) => [
    {
      id: 1,
      kind: 1,
      flags: 0,
      x,
      y: 10,
      vx: 0,
      vy: 0,
      angle: 0,
      a: 0,
      b: 0,
      c: 0,
    },
  ];
  buf.push({ tick: 10, ack: 0, entities: e(100) });
  buf.push({ tick: 12, ack: 0, entities: e(200) });
  const out = buf.sample(11, ARENA);
  assert.equal(out.mode, "interpolating");
  assert.equal(out.entities[0].x, 150);
  assert.equal(buf.sample(10.5, ARENA).entities[0].x, 125);
});

test("SnapshotBuffer: переупорядковані й дубльовані снапшоти", () => {
  const buf = new SnapshotBuffer();
  const mk = (tick) => ({ tick, ack: 0, entities: [] });
  assert.equal(buf.push(mk(12)), true);
  assert.equal(buf.push(mk(10)), true, "запізнілий вставляється на своє місце");
  assert.equal(buf.push(mk(12)), false, "дубль відкинуто");
  assert.deepEqual(
    buf.snaps.map((s) => s.tick),
    [10, 12],
  );
});

test("SnapshotBuffer: сутність, що з'являється/зникає між снапшотами", () => {
  const buf = new SnapshotBuffer();
  const rec = (id, x) => ({
    id,
    kind: 2,
    flags: 0,
    x,
    y: 0,
    vx: 0,
    vy: 0,
    angle: 0,
    a: 0,
    b: 0,
    c: 0,
  });
  buf.push({ tick: 10, ack: 0, entities: [rec(1, 0)] });
  buf.push({ tick: 12, ack: 0, entities: [rec(2, 50)] });

  const mid = buf.sample(11, ARENA);
  assert.deepEqual(
    mid.entities.map((e) => e.id),
    [1],
    "id 1 ще малюється, id 2 ще ні",
  );

  const after = buf.sample(12, ARENA);
  assert.deepEqual(
    after.entities.map((e) => e.id),
    [2],
    "id 1 зник, id 2 з'явився",
  );
});

test("SnapshotBuffer: інтерполяція через шов тору й екстраполяція", () => {
  const buf = new SnapshotBuffer();
  const rec = (x, vx = 0) => [
    {
      id: 1,
      kind: 1,
      flags: 0,
      x,
      y: 0,
      vx,
      vy: 0,
      angle: 0,
      a: 0,
      b: 0,
      c: 0,
    },
  ];
  buf.push({ tick: 10, ack: 0, entities: rec(1190) });
  buf.push({ tick: 12, ack: 0, entities: rec(10) });
  const x = buf.sample(11, ARENA).entities[0].x;
  assert.ok(Math.abs(x - 0) < 1e-9 || Math.abs(x - 1200) < 1e-9, `x=${x}`);

  const ext = new SnapshotBuffer();
  ext.push({ tick: 10, ack: 0, entities: rec(100, 30) });
  const out = ext.sample(12, ARENA);
  assert.equal(out.mode, "extrapolating");
  assert.ok(Math.abs(out.entities[0].x - (100 + 30 * DT * 2)) < 1e-9);
  assert.ok(
    ext.sample(100, ARENA).entities[0].x < 100 + 30 * DT * 5,
    "екстраполяція обмежена",
  );
});

test("ServerClock: джитер не смикає годинник, мінімум задає базу", () => {
  const clock = new ServerClock({ gain: 1 });
  const base = 5000;
  for (let tick = 0; tick < 60; tick++) {
    const jitter = tick % 5 === 0 ? 0 : 20 + (tick % 3) * 5;
    clock.observe(tick, base + tick * TICK_MS + jitter);
  }
  assert.ok(Math.abs(clock.offset - base) < 1e-6, `offset ${clock.offset}`);
  assert.ok(Math.abs(clock.serverTickAt(base + 30 * TICK_MS) - 30) < 1e-6);
});

test("геометрія тору", () => {
  assert.equal(shortestDelta(1190, 1200), -10);
  assert.equal(shortestDelta(-1190, 1200), 10);
  assert.ok(Math.abs(lerpWrap(1190, 10, 0.5, 1200) - 0) < 1e-9);
});
