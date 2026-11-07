import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { type Arena, type PlayerId, playerId } from "@dogfight/shared/types";

export class RoomFullError extends Error {
  constructor(roomId: string) {
    super(`Кімната ${roomId} заповнена`);
    this.name = "RoomFullError";
  }
}

export class TooManyRoomsError extends Error {
  constructor(limit: number) {
    super(`Досягнуто ліміт кімнат (${limit})`);
    this.name = "TooManyRoomsError";
  }
}

// Події кімнати: "join", "leave", "chat", "empty", "closed".
// Окрема подія "event" несе записи для логу матчу ({t, type, ...}).
// Жодного "error" тут не емітиться: помилки — це винятки, а не події.
export interface Player {
  readonly id: PlayerId;
  readonly name: string;
}

export interface RoomChatMessage {
  readonly from: string;
  readonly fromId: PlayerId;
  readonly text: string;
  readonly t: number;
}

// Запис журналу матчу: час, тип і довільні поля (JSON-серіалізовні).
export interface RoomRecord {
  readonly t: number;
  readonly type: string;
  readonly [field: string]: unknown;
}

export interface RoomSummary {
  readonly id: string;
  readonly name: string;
  readonly players: number;
  readonly maxPlayers: number;
  readonly arena: Arena;
}

// Типізовані події кімнати: назва -> кортеж аргументів слухача. EventEmitter
// з @types/node приймає цю карту generic-параметром, тож `room.on("join", p => …)`
// знає, що p — Player, а `room.on("jion", …)` не скомпілюється.
export interface RoomEvents {
  join: [player: Player];
  leave: [player: Player];
  chat: [message: RoomChatMessage];
  empty: [room: Room];
  closed: [room: Room];
  event: [record: RoomRecord];
}

export interface RoomOptions {
  id: string;
  name: string;
  maxPlayers: number;
  arena: Arena;
  now?: () => number;
}

export class Room extends EventEmitter<RoomEvents> {
  readonly id: string;
  readonly name: string;
  readonly maxPlayers: number;
  readonly arena: Arena;
  readonly now: () => number;
  readonly createdAt: number;
  logId: string | null = null;
  readonly #players = new Map<PlayerId, Player>();
  #seq = 0;

  constructor({ id, name, maxPlayers, arena, now = Date.now }: RoomOptions) {
    super();
    this.id = id;
    this.name = name;
    this.maxPlayers = maxPlayers;
    this.arena = arena;
    this.now = now;
    this.createdAt = now();
  }

  // Map гравців (лише для читання ззовні).
  get players(): ReadonlyMap<PlayerId, Player> {
    return this.#players;
  }

  get size(): number {
    return this.#players.size;
  }

  roster(): Player[] {
    return [...this.#players.values()].map(({ id, name }) => ({ id, name }));
  }

  summary(): RoomSummary {
    return {
      id: this.id,
      name: this.name,
      players: this.size,
      maxPlayers: this.maxPlayers,
      arena: this.arena,
    };
  }

  record(type: string, data: Record<string, unknown> = {}): void {
    this.emit("event", { t: this.now(), type, ...data });
  }

  add(name: string): Player {
    if (this.size >= this.maxPlayers) throw new RoomFullError(this.id);
    const player: Player = { id: playerId(++this.#seq), name };
    this.#players.set(player.id, player);
    this.record("join", { player });
    this.emit("join", player);
    return player;
  }

  remove(id: PlayerId): boolean {
    const player = this.#players.get(id);
    if (!player) return false;
    this.#players.delete(id);
    this.record("leave", { player });
    this.emit("leave", player);
    if (this.size === 0) this.emit("empty", this);
    return true;
  }

  chat(id: PlayerId, text: string): RoomChatMessage | null {
    const player = this.#players.get(id);
    if (!player) return null;
    const message: RoomChatMessage = { from: player.name, fromId: player.id, text, t: this.now() };
    this.record("chat", { from: player.id, text });
    this.emit("chat", message);
    return message;
  }

  close(): void {
    this.emit("closed", this);
  }
}

// RoomManager створює, шукає й видаляє кімнати. Порожня кімната видаляється
// за подією "empty". Кімната, до якої ніхто не зайшов (POST без join),
// видаляється за таймером roomIdleMs, інакше вони накопичувались би вічно.
// Події менеджера: створена й видалена кімната.
export interface RoomManagerEvents {
  created: [room: Room];
  deleted: [room: Room];
}

export interface RoomManagerOptions {
  maxRooms: number;
  maxPlayers: number;
  idleMs: number;
  now?: () => number;
}

export class RoomManager extends EventEmitter<RoomManagerEvents> {
  readonly maxRooms: number;
  readonly maxPlayers: number;
  readonly idleMs: number;
  readonly now: () => number;
  readonly #rooms = new Map<string, Room>();
  readonly #idleTimers = new Map<string, NodeJS.Timeout>();

  constructor({ maxRooms, maxPlayers, idleMs, now = Date.now }: RoomManagerOptions) {
    super();
    this.maxRooms = maxRooms;
    this.maxPlayers = maxPlayers;
    this.idleMs = idleMs;
    this.now = now;
  }

  get size(): number {
    return this.#rooms.size;
  }

  create({
    name,
    maxPlayers,
    arena,
  }: { name?: string; maxPlayers?: number; arena?: Arena } = {}): Room {
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

  get(id: string): Room | undefined {
    return this.#rooms.get(id);
  }

  list(): RoomSummary[] {
    return [...this.#rooms.values()].map((room) => room.summary());
  }

  delete(id: string): boolean {
    const room = this.#rooms.get(id);
    if (!room) return false;
    this.#rooms.delete(id);
    this.#clearIdle(id);
    room.record("deleted");
    room.close();
    this.emit("deleted", room);
    return true;
  }

  closeAll(): void {
    for (const id of [...this.#rooms.keys()]) this.delete(id);
  }

  #clearIdle(id: string): void {
    const timer = this.#idleTimers.get(id);
    if (timer) clearTimeout(timer);
    this.#idleTimers.delete(id);
  }
}
