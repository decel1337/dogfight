import assert from "node:assert/strict";
import { DT } from "../src/constants.ts";
import type { GameMessage, ParseResult } from "../src/protocol/index.ts";
import { Asteroid, type Controls, Ship, World } from "../src/sim/index.ts";
import { playerId } from "../src/types.ts";

export const NO_INPUT: Controls = { thrust: 0, turn: 0, fire: 0 };

export type ScriptedInput = Controls & { readonly seq: number };

// Звужує GameMessage до конкретного варіанта (або валить тест).
export function expectMessage<T extends GameMessage["type"]>(
  msg: GameMessage,
  type: T,
): Extract<GameMessage, { type: T }> {
  if (!isMessage(msg, type))
    assert.fail(`очікувалось ${type}, отримано ${msg.type}`);
  return msg;
}

function isMessage<T extends GameMessage["type"]>(
  msg: GameMessage,
  type: T,
): msg is Extract<GameMessage, { type: T }> {
  return msg.type === type;
}

// Звужує ParseResult до відмови (або валить тест).
export function expectRejected<T>(result: ParseResult<T>): {
  code: number;
  reason: string;
} {
  if (result.ok) assert.fail("очікувалась відмова");
  return result;
}

// Один крок гри так, як його робить сервер: спершу input гравців (рух
// кораблів), потім крок світу. inputs: Map<Ship, input>.
export function advance(
  world: World,
  inputs: Map<Ship, ScriptedInput> = new Map(),
): void {
  for (const [ship, input] of inputs) ship.applyInput(input, world);
  world.step();
}

// Світ із двома кораблями й кількома астероїдами; повністю від seed.
export function makeWorld(
  seed = 7,
  { asteroids = 5 }: { asteroids?: number } = {},
) {
  const world = new World({ seed });
  const a = world.spawn(new Ship(300, 400, { playerId: playerId(1) }));
  const b = world.spawn(new Ship(900, 400, { playerId: playerId(2) }));
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
const TURNS = [0, 1, 1, 0, -1, 0, -1] as const;

export function scriptedInput(step: number, phase = 0): ScriptedInput {
  const s = step + phase;
  return {
    thrust: s % 17 < 11 ? 1 : 0,
    turn: TURNS[Math.floor(s / 9) % 7] ?? 0,
    fire: s % 13 === 0 ? 1 : s % 41 === 0 ? 2 : 0,
    seq: step + 1,
  };
}

export function runScenario(steps = 1000, seed = 7): World {
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
