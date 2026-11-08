import assert from "node:assert/strict";
import { test } from "vitest";
import { sleep } from "./helpers.ts";
import { Room, RoomFullError, RoomManager, type RoomRecord, TooManyRoomsError } from "../src/rooms.ts";

const manager = (overrides: Partial<ConstructorParameters<typeof RoomManager>[0]> = {}) =>
  new RoomManager({ maxRooms: 3, maxPlayers: 2, idleMs: 60_000, ...overrides });

test("Room: join/leave/chat емітять події, roster оновлюється", () => {
  const room = new Room({ id: "r", name: "R", maxPlayers: 4, arena: { width: 800, height: 600 } });
  const seen: [string, string | null][] = [];
  room.on("join", (p) => seen.push(["join", p.name]));
  room.on("leave", (p) => seen.push(["leave", p.name]));
  room.on("chat", (m) => seen.push(["chat", m.text]));
  room.on("empty", () => seen.push(["empty", null]));

  const a = room.add("Ann");
  const b = room.add("Bob");
  assert.deepEqual(room.roster().map((p) => p.name), ["Ann", "Bob"]);
  room.chat(a.id, "hello");
  room.remove(a.id);
  room.remove(b.id);

  assert.deepEqual(seen.map((s) => s[0]), ["join", "join", "chat", "leave", "leave", "empty"]);
  assert.equal(room.chat(a.id, "ghost"), null, "чат від гравця, що вийшов");
});

test("Room: заповнена кімната кидає RoomFullError", () => {
  const room = new Room({ id: "r", name: "R", maxPlayers: 1, arena: { width: 800, height: 600 } });
  room.add("A");
  assert.throws(() => room.add("B"), RoomFullError);
});

test("Room: події для логу мають час і тип", () => {
  let tick = 100;
  const room = new Room({ id: "r", name: "R", maxPlayers: 2, arena: { width: 800, height: 600 }, now: () => tick++ });
  const events: RoomRecord[] = [];
  room.on("event", (e) => events.push(e));
  const p = room.add("A");
  room.chat(p.id, "hi");
  assert.deepEqual(events.map((e) => [e.t, e.type]), [
    [101, "join"], // 100 витрачено на createdAt
    [103, "chat"], // 102 витрачено на мітку часу самого повідомлення
  ]);
});

test("RoomManager: порожня кімната видаляється за подією empty", () => {
  const rooms = manager();
  const room = rooms.create({ name: "x" });
  const deleted: string[] = [];
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
