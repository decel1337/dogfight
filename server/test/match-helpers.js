import { hashWorld } from "@dogfight/shared/sim";
import { Match } from "../src/match.js";
import { RoomManager } from "../src/rooms.js";

// Прогін матчу з детермінованими input, повертає хеш світу.
export function runningHash(seed, ticks) {
  const rooms = new RoomManager({ maxRooms: 5, maxPlayers: 4, idleMs: 60_000 });
  const room = rooms.create({ name: "h" });
  const match = new Match({ room, seed });
  const ann = match.addPlayer(room.add("Ann"));
  void ann;
  const id = [...room.players.keys()][0];
  for (let t = 0; t < ticks; t++) {
    match.receiveInput(id, {
      seq: t + 1,
      tick: t,
      thrust: t % 17 < 11 ? 1 : 0,
      turn: [0, 1, 1, 0, -1][Math.floor(t / 9) % 5],
      fire: t % 13 === 0 ? 1 : 0,
    });
    match.tick();
  }
  return hashWorld(match.world);
}
