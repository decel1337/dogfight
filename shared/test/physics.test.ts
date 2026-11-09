import { describe, expect, test } from "vitest";
import { DT } from "../src/constants.ts";
import { mulberry32 } from "../src/prng.ts";
import type { ShipState } from "../src/sim/index.ts";
import {
  Asteroid,
  Bullet,
  integrate,
  Ship,
  Vector2,
  World,
} from "../src/sim/index.ts";

const ARENA = { width: 1200, height: 800 };
const REST: ShipState = {
  x: 600,
  y: 400,
  vx: 0,
  vy: 0,
  angle: 0,
  cooldown: 0,
  rapid: false,
};

describe("integrate", () => {
  test("без керування корабель у спокої залишається на місці", () => {
    const next = integrate(REST, { thrust: 0, turn: 0, fire: 0 }, DT, ARENA);
    expect(next.x).toBe(600);
    expect(next.y).toBe(400);
    expect(next.thrusting).toBe(false);
  });

  test("тяга розганяє вздовж кута; опір обмежує швидкість", () => {
    let state: ShipState = REST;
    for (let i = 0; i < 300; i++) {
      state = integrate(state, { thrust: 1, turn: 0, fire: 0 }, DT, ARENA);
    }
    const speed = Math.sqrt(state.vx * state.vx + state.vy * state.vy);
    expect(speed).toBeGreaterThan(100);
    expect(speed).toBeLessThan(10_000); // не росте безмежно: працює drag
  });

  test("повертає новий об'єкт і не змінює вхідний стан", () => {
    const frozen = Object.freeze({ ...REST });
    const next = integrate(frozen, { thrust: 1, turn: 1, fire: 0 }, DT, ARENA);
    expect(next).not.toBe(frozen);
    expect(frozen.x).toBe(600);
  });

  test("тор: вихід за правий край повертає ліворуч", () => {
    const next = integrate(
      { ...REST, x: 1199.9, vx: 300 },
      { thrust: 0, turn: 0, fire: 0 },
      DT,
      ARENA,
    );
    expect(next.x).toBeGreaterThanOrEqual(0);
    expect(next.x).toBeLessThan(50);
  });

  test("постріл: fired=1 лише коли охолодження минуло", () => {
    const first = integrate(REST, { thrust: 0, turn: 0, fire: 1 }, DT, ARENA);
    expect(first.fired).toBe(1);
    const second = integrate(first, { thrust: 0, turn: 0, fire: 1 }, DT, ARENA);
    expect(second.fired).toBe(0);
  });
});

describe("колізії: дискретна перевірка і тунелювання", () => {
  function shoot(speed: number, asteroidRadius: number): boolean {
    const world = new World();
    const ship = world.spawn(new Ship(100, 100));
    const rock = world.spawn(
      new Asteroid(500, 400, asteroidRadius, { rng: mulberry32(1) }),
    );
    rock.vel = new Vector2(0, 0);
    // Куля стартує за 188 px зліва від цілі (кроки по 100 px «перестрибують» центр на 12 px) й летить на неї.
    world.spawn(
      new Bullet(312, 400, new Vector2(speed, 0), 0, { ownerId: ship.id }),
    );
    for (let tick = 0; tick < 60; tick++) {
      world.step();
      if (world.get(rock.id) === undefined) return true;
    }
    return false;
  }

  test("звичайна куля (420 px/с, ≈14 px за тік) влучає в астероїд", () => {
    expect(shoot(420, 20)).toBe(true);
  });

  test("надшвидка куля пролітає крізь малу ціль: це відома межа дискретної перевірки", () => {
    // Крок 3000·DT = 100 px, а сума радіусів ≈ 8 px: центр «перестрибує» ціль.
    expect(shoot(3000, 4)).toBe(false);
  });

  test("велика ціль ловить і швидку кулю (сума радіусів > кроку)", () => {
    // Крок 100 px, радіус цілі 120: куля неодмінно потрапляє в зону хоч раз.
    expect(shoot(3000, 120)).toBe(true);
  });
});

describe("World.step: детермінізм", () => {
  function run(seed: number): number[] {
    const world = new World();
    const rng = mulberry32(seed);
    world.spawn(new Ship(200, 200));
    for (let i = 0; i < 6; i++)
      world.spawn(new Asteroid(rng() * 1200, rng() * 800, 20, { rng }));
    const xs: number[] = [];
    for (let t = 0; t < 120; t++) {
      world.step();
      for (const e of world) xs.push(e.pos.x, e.pos.y);
    }
    return xs;
  }

  test("однаковий seed — побітово однакова траєкторія всіх сутностей", () => {
    expect(run(11)).toEqual(run(11));
  });

  test("інший seed — інша траєкторія", () => {
    expect(run(11)).not.toEqual(run(12));
  });
});
