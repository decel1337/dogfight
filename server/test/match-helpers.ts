import { hashWorld } from "@dogfight/shared/sim";
import { Match } from "../src/match.ts";
import { RoomManager } from "../src/rooms.ts";

// Прогін матчу з детермінованими input, повертає хеш світу.
export function runningHash(seed: number, ticks: number): number {
  const rooms = new RoomManager({ maxRooms: 5, maxPlayers: 4, idleMs: 60_000 });
  const room = rooms.create({ name: "h" });
  const match = new Match({ room, seed });
  const ann = match.addPlayer(room.add("Ann"));
  void ann;
  const id = [...room.players.keys()][0];
  if (id === undefined) throw new Error("немає гравця");
  for (let t = 0; t < ticks; t++) {
    match.receiveInput(id, {
      type: "input",
      seq: t + 1,
      tick: t,
      thrust: t % 17 < 11 ? 1 : 0,
      turn: ([0, 1, 1, 0, -1] as const)[Math.floor(t / 9) % 5] ?? 0,
      fire: t % 13 === 0 ? 1 : 0,
    });
    match.tick();
  }
  return hashWorld(match.world);
}
