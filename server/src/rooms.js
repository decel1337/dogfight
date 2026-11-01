import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";

export class RoomFullError extends Error {
  constructor(roomId) {
    super(`Кімната ${roomId} заповнена`);
    this.name = "RoomFullError";
  }
}

export class TooManyRoomsError extends Error {
  constructor(limit) {
    super(`Досягнуто ліміт кімнат (${limit})`);
    this.name = "TooManyRoomsError";
  }
}

// Події кімнати: "join", "leave", "chat", "empty", "closed".
// Окрема подія "event" несе записи для логу матчу ({t, type, ...}).
// Жодного "error" тут не емітиться: помилки — це винятки, а не події.
export class Room extends EventEmitter {
  #players = new Map();
  #seq = 0;

  constructor({ id, name, maxPlayers, arena, now = Date.now }) {
    super();
    this.id = id;
    this.name = name;
    this.maxPlayers = maxPlayers;
    this.arena = arena;
    this.now = now;
    this.createdAt = now();
  }

  // Map гравців (лише для читання ззовні).
  get players() {
    return this.#players;
  }

  get size() {
    return this.#players.size;
  }

  roster() {
    return [...this.#players.values()].map(({ id, name }) => ({ id, name }));
  }

  summary() {
    return {
      id: this.id,
      name: this.name,
      players: this.size,
      maxPlayers: this.maxPlayers,
      arena: this.arena,
    };
  }

  record(type, data = {}) {
    this.emit("event", { t: this.now(), type, ...data });
  }

  add(name) {
    if (this.size >= this.maxPlayers) throw new RoomFullError(this.id);
    const player = { id: ++this.#seq, name };
    this.#players.set(player.id, player);
    this.record("join", { player });
    this.emit("join", player);
    return player;
  }

  remove(playerId) {
    const player = this.#players.get(playerId);
    if (!player) return false;
    this.#players.delete(playerId);
    this.record("leave", { player });
    this.emit("leave", player);
    if (this.size === 0) this.emit("empty", this);
    return true;
  }

  chat(playerId, text) {
    const player = this.#players.get(playerId);
    if (!player) return null;
    const message = {
      from: player.name,
      fromId: player.id,
      text,
      t: this.now(),
    };
    this.record("chat", { from: player.id, text });
    this.emit("chat", message);
    return message;
  }

  close() {
    this.emit("closed", this);
  }
}

// RoomManager створює, шукає й видаляє кімнати. Порожня кімната видаляється
// за подією "empty". Кімната, до якої ніхто не зайшов (POST без join),
// видаляється за таймером roomIdleMs, інакше вони накопичувались би вічно.
export class RoomManager extends EventEmitter {
  #rooms = new Map();
  #idleTimers = new Map();

  constructor({ maxRooms, maxPlayers, idleMs, now = Date.now }) {
    super();
    this.maxRooms = maxRooms;
    this.maxPlayers = maxPlayers;
    this.idleMs = idleMs;
    this.now = now;
  }

  get size() {
    return this.#rooms.size;
  }

  create({ name, maxPlayers, arena } = {}) {
    if (this.size >= this.maxRooms) throw new TooManyRoomsError(this.maxRooms);

    const id = `r-${randomBytes(4).toString("hex")}`;
    const room = new Room({
      id,
      name: name ?? id,
      maxPlayers: Math.min(maxPlayers ?? this.maxPlayers, this.maxPlayers),
      arena: arena ?? { width: 1200, height: 800 },
      now: this.now,
    });
    this.#rooms.set(id, room);

    room.once("empty", () => this.delete(id));
    room.once("join", () => this.#clearIdle(id));
    const timer = setTimeout(() => this.delete(id), this.idleMs);
    timer.unref();
    this.#idleTimers.set(id, timer);

    // Слухачі (лог матчу, WebSocket) підписуються синхронно, до першої події.
    this.emit("created", room);
    room.record("created", { room: room.summary() });
    return room;
  }

  get(id) {
    return this.#rooms.get(id);
  }

  list() {
    return [...this.#rooms.values()].map((room) => room.summary());
  }

  delete(id) {
    const room = this.#rooms.get(id);
    if (!room) return false;
    this.#rooms.delete(id);
    this.#clearIdle(id);
    room.record("deleted");
    room.close();
    this.emit("deleted", room);
    return true;
  }

  closeAll() {
    for (const id of [...this.#rooms.keys()]) this.delete(id);
  }

  #clearIdle(id) {
    clearTimeout(this.#idleTimers.get(id));
    this.#idleTimers.delete(id);
  }
}
