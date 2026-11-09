// Порівняння JSON і бінарного кодека на реальному стані світу: 4 гравці,
// 6 астероїдів, ~20 куль. Запуск: node shared/scripts/codec-bench.mjs
import { getCodec } from "../src/codec/index.ts";
import { TICK_RATE } from "../src/constants.ts";
import { Asteroid } from "../src/sim/entities.ts";
import { Bullet, Ship, World } from "../src/sim/index.ts";
import { Vector2 } from "../src/sim/vector.ts";

const world = new World({ seed: 3 });
for (let i = 0; i < 4; i++) {
  world.spawn(new Ship(150 + i * 300, 200 + i * 150, { playerId: i + 1 }));
}
for (let i = 0; i < 6; i++) {
  world.spawn(
    new Asteroid(world.rng() * 1200, world.rng() * 800, 18 + world.rng() * 14, {
      rng: world.rng,
    }),
  );
}
for (let i = 0; i < 20; i++) {
  world.spawn(
    new Bullet(
      world.rng() * 1200,
      world.rng() * 800,
      new Vector2(300 * world.rng() - 150, 300 * world.rng() - 150),
      world.rng() * 6 - 3,
      { ownerId: 1, tag: i },
    ),
  );
}
for (let i = 0; i < 40; i++) world.step(); // нетривіальні дробові числа
const snapshot = { type: "snapshot", ack: 1234, ...world.snapshot() };
const n = snapshot.entities.length;

const rows = [];
for (const name of ["json", "binary"]) {
  const codec = getCodec(name);
  const frame = codec.encode(snapshot);
  const bytes =
    typeof frame === "string"
      ? new TextEncoder().encode(frame).length
      : frame.byteLength;
  const reps = 20000;
  let t = performance.now();
  for (let i = 0; i < reps; i++) codec.encode(snapshot);
  const encUs = ((performance.now() - t) / reps) * 1000;
  t = performance.now();
  for (let i = 0; i < reps; i++) codec.decode(frame);
  const decUs = ((performance.now() - t) / reps) * 1000;
  rows.push({
    codec: name,
    "bytes/snapshot": bytes,
    "bytes/entity": (bytes / n).toFixed(1),
    "down KB/s per client": ((bytes * TICK_RATE) / 1024).toFixed(1),
    "server up KB/s (4 clients)": ((bytes * TICK_RATE * 4) / 1024).toFixed(1),
    "encode µs": encUs.toFixed(1),
    "decode µs": decUs.toFixed(1),
  });
}
console.log(`entities: ${n}, tick rate: ${TICK_RATE} Hz`);
console.table(rows);
const [json, bin] = rows;
console.log(
  `binary менший у ${(json["bytes/snapshot"] / bin["bytes/snapshot"]).toFixed(1)}× за JSON`,
);
// Неокруглений JSON — що було б без «чесного» округлення:
const raw = JSON.stringify({ v: 1, ...snapshot });
console.log(`JSON без округлення чисел: ${raw.length} байт`);
