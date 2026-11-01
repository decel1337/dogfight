import assert from "node:assert/strict";
import test from "node:test";
import { sleep } from "./helpers.js";
import {
  Room,
  RoomFullError,
  RoomManager,
  TooManyRoomsError,
} from "../src/rooms.js";

const manager = (overrides = {}) =>
  new RoomManager({ maxRooms: 3, maxPlayers: 2, idleMs: 60_000, ...overrides });

test("Room: join/leave/chat емітять події, roster оновлюється", () => {
  const room = new Room({ id: "r", name: "R", maxPlayers: 4, arena: {} });
  const seen = [];
  for (const type of ["join", "leave", "chat", "empty"]) {
    room.on(type, (data) =>
      seen.push([type, data?.name ?? data?.text ?? null]),
    );
  }

  const a = room.add("Ann");
  const b = room.add("Bob");
  assert.deepEqual(
    room.roster().map((p) => p.name),
    ["Ann", "Bob"],
  );
  room.chat(a.id, "hello");
  room.remove(a.id);
  room.remove(b.id);

  assert.deepEqual(
    seen.map((s) => s[0]),
    ["join", "join", "chat", "leave", "leave", "empty"],
  );
  assert.equal(room.chat(a.id, "ghost"), null, "чат від гравця, що вийшов");
});

test("Room: заповнена кімната кидає RoomFullError", () => {
  const room = new Room({ id: "r", name: "R", maxPlayers: 1, arena: {} });
  room.add("A");
  assert.throws(() => room.add("B"), RoomFullError);
});

test("Room: події для логу мають час і тип", () => {
  let tick = 100;
  const room = new Room({
    id: "r",
    name: "R",
    maxPlayers: 2,
    arena: {},
    now: () => tick++,
  });
  const events = [];
  room.on("event", (e) => events.push(e));
  const p = room.add("A");
  room.chat(p.id, "hi");
  assert.deepEqual(
    events.map((e) => [e.t, e.type]),
    [
      [101, "join"], // 100 витрачено на createdAt
      [103, "chat"], // 102 витрачено на мітку часу самого повідомлення
    ],
  );
});

test("RoomManager: порожня кімната видаляється за подією empty", () => {
  const rooms = manager();
  const room = rooms.create({ name: "x" });
  const deleted = [];
  rooms.on("deleted", (r) => deleted.push(r.id));

  const p = room.add("A");
  room.remove(p.id);
  assert.equal(rooms.get(room.id), undefined);
  assert.deepEqual(deleted, [room.id]);
});

test("RoomManager: ліміт кімнат і обмеження maxPlayers", () => {
  const rooms = manager({ maxRooms: 2 });
  assert.equal(rooms.create({ maxPlayers: 99 }).maxPlayers, 2);
  rooms.create();
  assert.throws(() => rooms.create(), TooManyRoomsError);
});

test("RoomManager: кімната без гравців видаляється за таймером", async () => {
  const rooms = manager({ idleMs: 30 });
  const room = rooms.create();
  assert.equal(rooms.size, 1);
  await sleep(80);
  assert.equal(rooms.get(room.id), undefined);
});

test("RoomManager: після першого join таймер простою скасовується", async () => {
  const rooms = manager({ idleMs: 30 });
  const room = rooms.create();
  room.add("A");
  await sleep(80);
  assert.equal(rooms.get(room.id), room);
});
