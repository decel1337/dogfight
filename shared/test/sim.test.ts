import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { DT, SHIP } from "../src/constants.ts";
import { mulberry32 } from "../src/prng.ts";
import {
  Asteroid,
  Bullet,
  DAMAGE,
  HomingBehavior,
  Pickup,
  Ship,
  Vector2,
  World,
  hashWorld,
  integrate,
  lerpAngle,
  type Integrate,
} from "../src/sim/index.ts";
import {
  advance,
  makeWorld,
  runScenario,
  type ScriptedInput,
  scriptedInput,
} from "./helpers.ts";

const still: ScriptedInput = { thrust: 0, turn: 0, fire: 0, seq: 1 };

test("mulberry32: той самий seed — та сама послідовність, стан відновлюється", () => {
  const a = mulberry32(123);
  const b = mulberry32(123);
  const xs = Array.from({ length: 5 }, a);
  assert.deepEqual(xs, Array.from({ length: 5 }, b));
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  const state = a.getState();
  const next = a();
  a.setState(state);
  assert.equal(a(), next);
  assert.notDeepEqual(xs, Array.from({ length: 5 }, mulberry32(124)));
});

test("integrate: чиста функція — не змінює аргументів, однаковий результат", () => {
  const arena = { width: 1200, height: 800 };
  const state = Object.freeze({
    x: 10,
    y: 20,
    vx: 5,
    vy: -3,
    angle: 0.5,
    cooldown: 0,
    rapid: false,
  });
  const input = Object.freeze({ thrust: 1, turn: 1, fire: 1 });
  const a = integrate(state, input, DT, arena);
  const b = integrate(state, input, DT, arena);
  assert.deepEqual(a, b);
  assert.equal(a.fired, 1);
  assert.equal(a.cooldown, SHIP.cooldownTicks);
  assert.equal(state.x, 10);
});

test("integrate: тор арени і нормалізація кута", () => {
  const arena = { width: 100, height: 100 };
  const out = integrate(
    { x: 99, y: 1, vx: 300, vy: -300, angle: 3.1, cooldown: 0, rapid: false },
    { thrust: 0, turn: 1, fire: 0 },
    DT,
    arena,
  );
  assert.ok(out.x >= 0 && out.x < 100 && out.y >= 0 && out.y < 100);
  assert.ok(out.angle >= -Math.PI && out.angle <= Math.PI);
});

test("інтерполяція кута йде найкоротшою дугою", () => {
  const a = lerpAngle(Math.PI - 0.1, -Math.PI + 0.1, 0.5);
  assert.ok(Math.abs(Math.abs(a) - Math.PI) < 1e-9);
});

test("детермінізм: однаковий seed і input -> однаковий хеш", () => {
  assert.equal(hashWorld(runScenario(600)), hashWorld(runScenario(600)));
  assert.notEqual(hashWorld(runScenario(600, 7)), hashWorld(runScenario(600, 8)));
});

test("детермінізм: вихідний код sim/ не містить недетермінованих викликів", () => {
  const forbidden =
    /\b(Math\.random|Date\.now|new Date|performance\.now|setTimeout|setInterval|document|window|process\.|require\()/;
  const nodeImport = /from\s+["']node:/;
  const dirs = ["sim", "netcode", "codec", "protocol"];
  for (const dir of dirs) {
    for (const file of readdirSync(new URL(`../src/${dir}/`, import.meta.url))) {
      const source = readFileSync(new URL(`../src/${dir}/${file}`, import.meta.url), "utf8");
      const code = source
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n");
      assert.doesNotMatch(code, nodeImport, `${dir}/${file}: імпорт node:`);
      if (dir === "sim") {
        assert.doesNotMatch(code, forbidden, `${dir}/${file}: недетермінований виклик`);
      }
    }
  }
});

test("якщо в integrate потрапляє Math.random() — стани розходяться", () => {
  const arena = { width: 1200, height: 800 };
  const noisy: Integrate = (s, i, dt, a) => {
    const out = integrate(s, i, dt, a);
    return { ...out, x: out.x + (Math.random() - 0.5) * 0.2 };
  };
  let clean = { x: 100, y: 100, vx: 0, vy: 0, angle: 0, cooldown: 0, rapid: false };
  let a = clean;
  let b = clean;
  for (let i = 0; i < 100; i++) {
    const input = scriptedInput(i);
    a = integrate(a, input, DT, arena);
    b = noisy(b, input, DT, arena);
  }
  assert.notEqual(a.x, b.x);
});

test("World: id призначає світ, ітератор, ofKind-генератор, відкладене видалення", () => {
  const world = new World();
  const ship = world.spawn(new Ship(100, 100));
  const rock = world.spawn(new Asteroid(500, 500, 20, { rng: mulberry32(1) }));
  assert.deepEqual([ship.id, rock.id], [1, 2]);
  assert.deepEqual([...world].map((e) => e.kind), ["ship", "asteroid"]);
  assert.deepEqual([...world.ofKind("asteroid")], [rock]);

  world.despawn(rock.id);
  assert.equal(world.get(rock.id), rock, "до кінця кроку сутність ще в Map");
  world.step();
  assert.equal(world.get(rock.id), undefined, "після кроку — прибрано");
});

test("World: id вміщуються в u16 і не повторюються, поки зайняті", () => {
  const world = new World();
  const ids = new Set();
  for (let i = 0; i < 300; i++) {
    const e = world.spawn(new Pickup(0, 0));
    assert.ok(e.id >= 1 && e.id <= 0xffff);
    assert.ok(!ids.has(e.id));
    ids.add(e.id);
  }
});

test("Ship: hp приватне — читання через getter, запис заборонений", () => {
  const ship = new Ship(0, 0);
  assert.equal(ship.hp, SHIP.maxHp);
  assert.throws(() => {
    // @ts-expect-error hp — лише getter: компілятор теж не дозволить запис
    ship.hp = 100;
  }, TypeError);
});

test("Ship: input рухає корабель, постріл успадковує швидкість, cooldown блокує", () => {
  const world = new World();
  const ship = world.spawn(new Ship(100, 100));
  ship.vel = new Vector2(100, 0);
  const fired = [];
  world.on("fired", (e) => fired.push(e));

  const bullet = ship.applyInput({ thrust: 0, turn: 0, fire: 1, seq: 9 }, world);
  assert.ok(bullet instanceof Bullet);
  assert.equal(bullet.tag, 9);
  assert.equal(bullet.ownerId, ship.id);
  assert.ok(bullet.vel.x > 420, "успадкувало частину швидкості корабля");
  assert.equal(
    ship.applyInput({ thrust: 0, turn: 0, fire: 1, seq: 10 }, world),
    null,
    "cooldown блокує другий постріл",
  );
  assert.equal(fired.length, 1);
});

test("Ship: смерть, вибух, респавн через 2 с у безпечному місці, невразливість", () => {
  const world = new World({ seed: 5 });
  const ship = world.spawn(new Ship(600, 400));
  world.spawn(new Asteroid(900, 700, 20, { rng: world.rng }));
  const exploded = [];
  world.on("exploded", (e) => exploded.push(e));

  let result;
  for (let i = 0; i < SHIP.maxHp; i++) result = ship.takeDamage(world);
  assert.equal(result, DAMAGE.killed);
  assert.equal(ship.hp, 0);
  assert.equal(ship.dead, true);
  assert.equal(ship.collidable, false);
  assert.equal(exploded.length, 1);

  for (let i = 0; i < SHIP.respawnTicks - 1; i++) world.step();
  assert.equal(ship.dead, true);
  world.step();
  assert.equal(ship.dead, false);
  assert.equal(ship.hp, SHIP.maxHp);
  assert.ok(ship.invulnerableTicks > 0);
  assert.equal(ship.takeDamage(world), DAMAGE.none, "невразливий після респавну");
});

test("Колізії: куля збиває астероїд і додає очки власнику", () => {
  const world = new World();
  const ship = world.spawn(new Ship(100, 100));
  const rock = world.spawn(new Asteroid(500, 500, 20, { rng: mulberry32(2) }));
  rock.vel = new Vector2(0, 0);
  const bullet = world.spawn(
    new Bullet(500, 500, new Vector2(0, 0), 0, { ownerId: ship.id }),
  );
  world.step();
  assert.equal(ship.score, 100);
  assert.equal(world.get(rock.id), undefined);
  assert.equal(world.get(bullet.id), undefined);
});

test("Колізії: куля влучає в ЧУЖИЙ корабель, у свій — ні; убивство дає очки", () => {
  const world = new World();
  const shooter = world.spawn(new Ship(100, 100));
  const target = world.spawn(new Ship(500, 500));
  world.spawn(new Bullet(100, 100, new Vector2(0, 0), 0, { ownerId: shooter.id }));
  world.step();
  assert.equal(shooter.hp, SHIP.maxHp, "у себе не влучаємо");
  assert.equal(world.size, 3, "власна куля жива");

  const b = world.spawn(new Bullet(500, 500, new Vector2(0, 0), 0, { ownerId: shooter.id }));
  world.step();
  assert.equal(target.hp, SHIP.maxHp - 1);
  assert.equal(world.get(b.id), undefined);

  target.invulnerableTicks = 0;
  target.takeDamage(world);
  world.spawn(new Bullet(500, 500, new Vector2(0, 0), 0, { ownerId: shooter.id }));
  world.step();
  assert.equal(target.dead, true);
  assert.equal(shooter.score, 250);
});

test("Колізії: щит поглинає удар; невразливість не знищує астероїд", () => {
  const world = new World();
  const ship = world.spawn(new Ship(500, 500));
  const rock = world.spawn(new Asteroid(500, 500, 20, { rng: mulberry32(3) }));
  rock.vel = new Vector2(0, 0);
  ship.activateShield();
  world.step();
  assert.equal(ship.hp, SHIP.maxHp);
  assert.equal(ship.shield, false);
  assert.equal(rock.alive, false);

  const rock2 = world.spawn(new Asteroid(500, 500, 20, { rng: mulberry32(4) }));
  rock2.vel = new Vector2(0, 0);
  ship.invulnerableTicks = 10;
  world.step();
  assert.equal(rock2.alive, true);
  assert.equal(ship.hp, SHIP.maxHp);
});

test("Колізії: зіткнення з астероїдом відштовхує корабель (серверна поправка)", () => {
  const world = new World();
  const ship = world.spawn(new Ship(500, 500));
  const rock = world.spawn(new Asteroid(515, 500, 20, { rng: mulberry32(3) }));
  rock.vel = new Vector2(0, 0);
  ship.invulnerableTicks = 100;
  world.step();
  assert.ok(ship.vel.x < 0, "штовхає від астероїда");
});

test("Pickup: нерухомий, не корабель, дає ефект через дані", () => {
  const world = new World();
  const ship = world.spawn(new Ship(300, 300));
  world.spawn(new Pickup(300, 300, "shield"));
  world.spawn(new Pickup(300, 300, "rapid"));
  world.step();
  assert.equal(ship.shield, true);
  assert.ok(ship.rapidTicks > 0);
  assert.equal([...world.ofKind("pickup")].length, 0);
});

test("Композиція: той самий HomingBehavior у кулі й астероїда", () => {
  const world = new World();
  const ship = world.spawn(new Ship(900, 100));
  const rock = world.spawn(new Asteroid(100, 400, 20, { rng: mulberry32(9) }));
  rock.vel = new Vector2(0, 0);
  const bullet = world.spawn(
    new Bullet(400, 400, new Vector2(0, -50), -Math.PI / 2, {
      ownerId: ship.id,
      homing: true,
    }),
  );
  const hunter = world.spawn(
    new Asteroid(900, 700, 20, { homing: true, rng: mulberry32(10) }),
  );
  assert.ok(bullet.behaviors[0] instanceof HomingBehavior);
  assert.ok(hunter.behaviors[0] instanceof HomingBehavior);

  const before = hunter.pos.dist(ship.pos);
  for (let i = 0; i < 30; i++) world.step();
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
  world.step();
  assert.equal(calls, 1);
});

test("snapshot -> fromSnapshot -> snapshot: реплікований стан зберігається", () => {
  const world = runScenario(200);
  const first = world.snapshot();
  const rebuilt = World.fromSnapshot(first, { seed: 7 });
  const again = rebuilt.snapshot();
  assert.equal(again.tick, first.tick);
  // Часткові серверні таймери не реплікуються, решта має збігатися.
  assert.deepEqual(again.entities, first.entities);
});

test("snapshot — плоскі дані, JSON-серіалізовані без втрат", () => {
  const snap = runScenario(100).snapshot();
  assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap);
  assert.equal(typeof structuredClone(snap).tick, "number");
});

test("кораблі рухаються лише через input: без input стан не змінюється", () => {
  const { world, a } = makeWorld();
  const before = JSON.stringify(a.toSnapshot());
  for (let i = 0; i < 5; i++) advance(world);
  assert.equal(JSON.stringify(a.toSnapshot()), before);
  advance(world, new Map([[a, { ...still, thrust: 1 as const, seq: 1 }]]));
  assert.notEqual(JSON.stringify(a.toSnapshot()), before);
});

import { atan2 as dAtan2, cos as dCos, sin as dSin } from "../src/sim/dmath.ts";

test("dmath: збігається з Math.* з точністю 1e-9 і лишається в межах кутів", () => {
  for (let a = -20; a <= 20; a += 0.0137) {
    assert.ok(Math.abs(dSin(a) - Math.sin(a)) < 1e-9, `sin ${a}`);
    assert.ok(Math.abs(dCos(a) - Math.cos(a)) < 1e-9, `cos ${a}`);
  }
  for (let y = -5; y <= 5; y += 0.37) {
    for (let x = -5; x <= 5; x += 0.41) {
      assert.ok(Math.abs(dAtan2(y, x) - Math.atan2(y, x)) < 1e-9, `atan2 ${y},${x}`);
    }
  }
  assert.equal(dAtan2(0, 0), 0);
  assert.ok(Math.abs(dAtan2(1, 0) - Math.PI / 2) < 1e-12);
  assert.ok(Math.abs(dAtan2(0, -1) - Math.PI) < 1e-12);
});
