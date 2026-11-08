import assert from "node:assert/strict";
import { test } from "vitest";
import { runningHash } from "./match-helpers.ts";
import type { InputMessage } from "@dogfight/shared/protocol";
import { Match, type MatchFrame } from "../src/match.ts";
import { RoomManager } from "../src/rooms.ts";

function makeMatch(seed = 5) {
  const rooms = new RoomManager({ maxRooms: 5, maxPlayers: 4, idleMs: 60_000 });
  const room = rooms.create({ name: "m" });
  const player = room.add("Ann");
  const match = new Match({ room, seed });
  const ship = match.addPlayer(player);
  return { rooms, room, match, ship, player };
}

const inp = (seq: number, o: Partial<InputMessage> = {}): InputMessage => ({
  type: "input",
  seq,
  tick: 0,
  thrust: 0,
  turn: 0,
  fire: 0,
  ...o,
});

// tick() синхронний: кадр емітиться всередині виклику.
function tickFrame(match: Match): MatchFrame {
  let frame: MatchFrame | undefined;
  match.once("frame", (f) => {
    frame = f;
  });
  match.tick();
  if (!frame) throw new Error("tick не видав кадр");
  return frame;
}

test("match: input рухає корабель, ack = останній оброблений seq", () => {
  const { match, ship, player } = makeMatch();
  const x0 = ship.pos.x;
  match.receiveInput(player.id, inp(1, { thrust: 1 }));
  match.receiveInput(player.id, inp(2, { thrust: 1 }));
  assert.equal(tickFrame(match).acks.get(player.id), 1, "один крок на тик");
  assert.equal(tickFrame(match).acks.get(player.id), 2);
  assert.notEqual(ship.pos.x, x0);
});

test("match: speed-hack (100 input за раз) не прискорює корабель", () => {
  const honest = makeMatch(9);
  const cheat = makeMatch(9);
  for (let i = 1; i <= 50; i++) honest.match.receiveInput(honest.player.id, inp(i, { thrust: 1 }));
  for (let i = 1; i <= 500; i++) cheat.match.receiveInput(cheat.player.id, inp(i, { thrust: 1 }));
  for (let t = 0; t < 10; t++) {
    honest.match.tick();
    cheat.match.tick();
  }
  assert.ok(cheat.match.rejected > 400, "черга обмежена, надлишок відкинуто");
  // 10 тиків => не більше 10 + MAX_BUDGET кроків, а не 500
  assert.ok(cheat.ship.vel.length() <= honest.ship.vel.length() * 1.5);
});

test("match: старі й дубльовані seq відкидаються", () => {
  const { match, player } = makeMatch();
  assert.equal(match.receiveInput(player.id, inp(5)), true);
  assert.equal(match.receiveInput(player.id, inp(5)), false);
  assert.equal(match.receiveInput(player.id, inp(3)), false);
  assert.equal(match.rejected, 2);
});

test("match: removePlayer прибирає корабель зі світу", () => {
  const { match, ship, player } = makeMatch();
  match.removePlayer(player.id);
  match.tick();
  assert.equal(match.world.get(ship.id), undefined);
});

test("match: однаковий seed + однакові input = однаковий хеш світу", () => {
  assert.equal(runningHash(11, 300), runningHash(11, 300));
  assert.notEqual(runningHash(11, 300), runningHash(12, 300));
});

test("match: постріл породжує подію fired і кулю з тегом seq", () => {
  const { match, player, ship } = makeMatch();
  match.receiveInput(player.id, inp(7, { fire: 1 }));
  const frame = tickFrame(match);
  assert.ok(frame.events.some((e) => e.kind === 1));
  const bullet = frame.snapshot.entities.find((e) => e.kind === 2);
  assert.ok(bullet);
  assert.equal(bullet.b, 7);
  assert.equal(bullet.c, ship.id, "власник кулі — наш корабель");
});
