import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { createAccumulator } from "../src/loop.js";
import { HomingBehavior } from "../src/sim/behaviors.js";
import {
  Asteroid,
  Bullet,
  Pickup,
  Ship,
} from "../src/sim/entities.js";
import { Vector2, lerpAngle } from "../src/sim/vector.js";
import { World } from "../src/sim/world.js";
import { collect, fakeInput, seeded } from "./helpers.mjs";

const DT = 1 / 60;

function stepN(world, n, input) {
  for (let i = 0; i < n; i++) world.step(DT, input);
}

test("акумулятор: рівно 60 кроків/с незалежно від частоти кадрів", () => {
  for (const frameMs of [1000 / 30, 1000 / 60, 1000 / 144, 1000 / 240]) {
    const acc = createAccumulator({ step: DT });
    let steps = 0;
    const frames = Math.round(10_000 / frameMs);
    for (let i = 0; i < frames; i++) {
      const { alpha } = acc.push(frameMs / 1000, () => steps++);
      assert.ok(alpha >= 0 && alpha < 1);
    }
    // 10 секунд -> 600 кроків (±1 через похибку float).
    assert.ok(Math.abs(steps - 600) <= 1, `${frameMs} мс: ${steps} кроків`);
  }
});

test("акумулятор: довга пауза затискається (немає spiral of death)", () => {
  const acc = createAccumulator({ step: DT, maxFrame: 0.25 });
  let steps = 0;
  acc.push(30, () => steps++);
  assert.equal(steps, 15);
});

test("детермінізм: однакові вхідні дані -> однаковий стан", () => {
  const run = () => {
    const world = new World({ rng: seeded(42) });
    const ship = world.spawn(new Ship(600, 400));
    for (let i = 0; i < 6; i++) {
      world.spawn(
        new Asteroid(100 + i * 150, 100 + i * 90, 22, { rng: world.rng }),
      );
    }
    const input = fakeInput(["KeyW", "KeyD", "Space"]);
    stepN(world, 600, input);
    return JSON.stringify({
      pos: ship.pos,
      vel: ship.vel,
      angle: ship.angle,
      score: ship.score,
      hp: ship.hp,
      size: world.size,
    });
  };
  assert.equal(run(), run());
});

test("інтерполяція кута йде найкоротшою дугою", () => {
  const a = lerpAngle(Math.PI - 0.1, -Math.PI + 0.1, 0.5);
  assert.ok(Math.abs(Math.abs(a) - Math.PI) < 1e-9);
});

test("World: ітератор, ofKind-генератор, відкладене видалення", () => {
  const world = new World();
  const ship = world.spawn(new Ship(100, 100));
  const rock = world.spawn(new Asteroid(500, 500, 20, { rng: seeded(1) }));

  assert.deepEqual([...world].map((e) => e.kind).sort(), ["asteroid", "ship"]);
  assert.deepEqual([...world.ofKind("asteroid")], [rock]);
  assert.equal(world.get(ship.id), ship);

  world.despawn(rock.id);
  assert.equal(world.get(rock.id), rock, "до кінця кроку сутність ще в Map");
  world.step(DT);
  assert.equal(world.get(rock.id), undefined, "після кроку — прибрано");
});

test("Entity: id унікальні, приватний лічильник недоступний ззовні", () => {
  const a = new Ship(0, 0);
  const b = new Ship(0, 0);
  assert.notEqual(a.id, b.id);
  assert.throws(() => {
    a.id = 999;
  }, TypeError);
});

test("Ship: hp приватне — читання через getter, запис заборонений", () => {
  const ship = new Ship(0, 0);
  assert.equal(ship.hp, Ship.MAX_HP);
  assert.throws(() => {
    ship.hp = 100;
  }, TypeError);
});

test("Ship: стрільба успадковує швидкість і дотримується cooldown", () => {
  const world = new World();
  const ship = world.spawn(new Ship(100, 100));
  ship.vel = new Vector2(100, 0);
  const fired = collect(world, "fired");

  const bullet = ship.fire(world);
  assert.ok(bullet instanceof Bullet);
  assert.equal(bullet.vel.x, 420 + 30);
  assert.equal(ship.fire(world), null, "cooldown блокує другий постріл");
  assert.equal(fired.length, 1);
});

test("Ship: смерть, вибух, респавн через 2 с у безпечному місці", () => {
  const world = new World({ rng: seeded(5) });
  const ship = world.spawn(new Ship(600, 400));
  world.spawn(new Asteroid(900, 700, 20, { rng: world.rng }));
  const exploded = collect(world, "exploded");

  for (let i = 0; i < Ship.MAX_HP; i++) {
    ship.invulnerable = 0;
    ship.takeDamage(world);
  }
  assert.equal(ship.hp, 0);
  assert.equal(ship.dead, true);
  assert.equal(ship.collidable, false);
  assert.equal(exploded.length, 1);
  assert.equal([...world.ofKind("explosion")].length, 1);

  stepN(world, 100, undefined); // ~1.67 с
  assert.equal(ship.dead, true);
  stepN(world, 30, undefined); // > 2 с
  assert.equal(ship.dead, false);
  assert.equal(ship.hp, Ship.MAX_HP);
  assert.ok(ship.invulnerable > 0);
});

test("Колізії: куля збиває астероїд і додає очки власнику", () => {
  const world = new World();
  const ship = world.spawn(new Ship(100, 100));
  const rock = world.spawn(new Asteroid(500, 500, 20, { rng: seeded(2) }));
  rock.vel = new Vector2(0, 0);
  const bullet = world.spawn(
    new Bullet(500, 500, new Vector2(0, 0), 0, { ownerId: ship.id }),
  );

  world.step(DT);
  assert.equal(ship.score, 100);
  assert.equal(world.get(rock.id), undefined);
  assert.equal(world.get(bullet.id), undefined);
});

test("Колізії: щит поглинає удар; невразливість не знищує астероїд", () => {
  const world = new World();
  const ship = world.spawn(new Ship(500, 500));
  const rock = world.spawn(new Asteroid(500, 500, 20, { rng: seeded(3) }));
  rock.vel = new Vector2(0, 0);
  ship.activateShield();
  world.step(DT);
  assert.equal(ship.hp, Ship.MAX_HP);
  assert.equal(ship.shield, false);
  assert.equal(rock.alive, false);

  const rock2 = world.spawn(new Asteroid(500, 500, 20, { rng: seeded(4) }));
  rock2.vel = new Vector2(0, 0);
  ship.invulnerable = 1;
  world.step(DT);
  assert.equal(rock2.alive, true);
  assert.equal(ship.hp, Ship.MAX_HP);
});

test("Pickup: нерухомий, не корабель, дає ефект через дані", () => {
  const world = new World();
  const ship = world.spawn(new Ship(300, 300));
  world.spawn(new Pickup(300, 300, "shield"));
  world.spawn(new Pickup(300, 300, "rapid"));
  world.step(DT);
  assert.equal(ship.shield, true);
  assert.ok(ship.rapidTimer > 0);
  assert.equal([...world.ofKind("pickup")].length, 0);
});

test("Композиція: той самий HomingBehavior у кулі й астероїда", () => {
  const world = new World();
  const ship = world.spawn(new Ship(900, 100));
  const rock = world.spawn(new Asteroid(100, 400, 20, { rng: seeded(9) }));
  rock.vel = new Vector2(0, 0);
  const bullet = world.spawn(
    new Bullet(400, 400, new Vector2(0, -50), -Math.PI / 2, {
      ownerId: ship.id,
      homing: true,
    }),
  );
  const hunter = world.spawn(
    new Asteroid(900, 700, 20, { homing: true, rng: seeded(10) }),
  );

  assert.ok(bullet.behaviors[0] instanceof HomingBehavior);
  assert.ok(hunter.behaviors[0] instanceof HomingBehavior);
  assert.equal(bullet.behaviors[0].targetKind, "asteroid");
  assert.equal(hunter.behaviors[0].targetKind, "ship");

  const before = hunter.pos.dist(ship.pos);
  stepN(world, 60);
  assert.ok(hunter.pos.dist(ship.pos) < before, "мисливець наближається");
});

test("Колізійну систему можна замінити (swappable)", () => {
  let calls = 0;
  const world = new World({
    collisions: function* () {
      calls++;
    },
  });
  world.spawn(new Ship(1, 1));
  world.step(DT);
  assert.equal(calls, 1);
});

test("Wrap: тор арени без смуги інтерполяції", () => {
  const world = new World({ arena: { width: 100, height: 100 } });
  const ship = world.spawn(new Ship(99, 50));
  ship.vel = new Vector2(120, 0);
  world.step(DT);
  assert.ok(ship.pos.x >= 0 && ship.pos.x < 100);
  assert.equal(ship.prevPos, ship.pos, "prev зафіксовано після телепорту");
});

test("sim/ не залежить від DOM, canvas, аудіо чи HUD", () => {
  const forbidden = /\b(document|window|canvas|AudioContext|localStorage)\b/;
  const imports = /from\s+"(\.\.\/(audio|render|lobby)[^"]*)"/;
  for (const file of readdirSync(new URL("../src/sim/", import.meta.url))) {
    const source = readFileSync(new URL(`../src/sim/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, forbidden, `${file}: DOM/browser API`);
    assert.doesNotMatch(source, imports, `${file}: імпорт audio/render/lobby`);
  }
});
