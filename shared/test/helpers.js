import { DT } from "../src/constants.js";
import { Asteroid, Ship, World } from "../src/sim/index.js";

export const NO_INPUT = Object.freeze({ thrust: 0, turn: 0, fire: 0 });

// Один крок гри так, як його робить сервер: спершу input гравців (рух
// кораблів), потім крок світу. inputs: Map<Ship, input>.
export function advance(world, inputs = new Map()) {
  for (const [ship, input] of inputs) ship.applyInput(input, world);
  world.step();
}

// Світ із двома кораблями й кількома астероїдами; повністю від seed.
export function makeWorld(seed = 7, { asteroids = 5 } = {}) {
  const world = new World({ seed });
  const a = world.spawn(new Ship(300, 400, { playerId: 1 }));
  const b = world.spawn(new Ship(900, 400, { playerId: 2 }));
  for (let i = 0; i < asteroids; i++) {
    world.spawn(
      new Asteroid(
        world.rng() * world.arena.width,
        world.rng() * world.arena.height,
        20 + world.rng() * 12,
        { rng: world.rng },
      ),
    );
  }
  world.spawn(new Asteroid(120, 120, 24, { homing: true, rng: world.rng }));
  return { world, a, b };
}

// Детермінований «сценарій»: послідовність input, залежна лише від номера кроку.
export function scriptedInput(step, phase = 0) {
  const s = step + phase;
  return {
    thrust: s % 17 < 11 ? 1 : 0,
    turn: [0, 1, 1, 0, -1, 0, -1][Math.floor(s / 9) % 7],
    fire: s % 13 === 0 ? 1 : s % 41 === 0 ? 2 : 0,
    seq: step + 1,
  };
}

export function runScenario(steps = 1000, seed = 7) {
  const { world, a, b } = makeWorld(seed);
  for (let i = 0; i < steps; i++) {
    advance(
      world,
      new Map([
        [a, scriptedInput(i, 0)],
        [b, scriptedInput(i, 5)],
      ]),
    );
  }
  return world;
}

export { DT };
