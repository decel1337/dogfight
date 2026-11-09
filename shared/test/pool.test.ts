import assert from "node:assert/strict";
import { test } from "vitest";
import { BULLET } from "../src/constants.ts";
import { Pool } from "../src/pool.ts";
import { Bullet, World } from "../src/sim/index.ts";
import { Vector2 } from "../src/sim/vector.ts";
import { NO_ENTITY } from "../src/types.ts";

test("Pool: acquire створює лише за потреби, release дає перевикористання", () => {
  const pool = new Pool(() => ({ n: 0 }));
  const a = pool.acquire();
  const b = pool.acquire();
  assert.equal(pool.created, 2);
  pool.release(a);
  assert.equal(pool.available, 1);
  assert.equal(pool.acquire(), a, "той самий об'єкт");
  assert.equal(pool.created, 2, "нових не створено");
  pool.release(a);
  pool.release(b);
  assert.equal(pool.available, 2);
});

test("Pool: max обмежує розмір (зайві віддаються GC)", () => {
  const pool = new Pool(() => ({}), 2);
  const items = [pool.acquire(), pool.acquire(), pool.acquire()];
  for (const item of items) pool.release(item);
  assert.equal(pool.available, 2);
});

test("Bullet.acquire повністю скидає стан (homing -> звичайна не лишає поведінок)", () => {
  const homing = Bullet.acquire(1, 2, new Vector2(3, 4), 0.5, {
    homing: true,
    tag: 7,
  });
  assert.equal(homing.behaviors.length, 1);
  homing.alive = false;
  homing.ttl = 1;
  homing.id = 42 as never;
  Bullet.release(homing);

  const plain = Bullet.acquire(9, 8, new Vector2(1, 0), 0);
  assert.equal(plain, homing, "об'єкт з пулу");
  assert.equal(plain.behaviors.length, 0);
  assert.equal(plain.alive, true);
  assert.equal(plain.id, NO_ENTITY);
  assert.equal(plain.homing, false);
  assert.equal(plain.tag, 0);
  assert.equal(plain.ttl, BULLET.ttlTicks);
  assert.deepEqual([plain.pos.x, plain.pos.y, plain.vel.x], [9, 8, 1]);
  Bullet.release(plain);
});

test("світ повертає мертві кулі в пул і не втрачає їх при перевикористанні", () => {
  const world = new World({ seed: 1 });
  const before = Bullet.pool.available;
  const b = world.spawn(Bullet.acquire(100, 100, new Vector2(0, 0), 0));
  b.ttl = 1; // помре на першому кроці
  world.step();
  assert.equal(world.get(b.id), undefined);
  assert.ok(Bullet.pool.available >= before, "куля повернулась у пул");
  const again = Bullet.acquire(5, 5, new Vector2(0, 0), 0);
  assert.equal(again.alive, true);
  Bullet.release(again);
});
