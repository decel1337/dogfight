import { EventEmitter } from "node:events";
import { SHIP } from "@dogfight/shared/constants";
import type { GameEvent, InputMessage } from "@dogfight/shared/protocol";
import type { Snapshot, WorldEvents } from "@dogfight/shared/sim";
import {
  Asteroid,
  PICKUP_TYPES,
  Pickup,
  Ship,
  World,
} from "@dogfight/shared/sim";
import {
  type PlayerId,
  SEQ_ZERO,
  type SeqNo,
  TICK_ZERO,
  type Tick,
  tick,
} from "@dogfight/shared/types";
import type { Player, Room } from "./rooms.ts";
import { Ticker, type TickerOptions } from "./ticker.ts";

// Коди подій для клієнтів (див. специфікацію бінарного протоколу).
export const EVENT_KIND = {
  fired: 1,
  hit: 2,
  exploded: 3,
} as const satisfies Record<keyof WorldEvents, GameEvent["kind"]>;

const WORLD_EVENT_TYPES = [
  "fired",
  "hit",
  "exploded",
] as const satisfies readonly (keyof WorldEvents)[];

// Якщо у WorldEvents з'явиться нова подія без запису в списку — це не скомпілюється.
const _allWorldEvents: Exclude<
  keyof WorldEvents,
  (typeof WORLD_EVENT_TYPES)[number]
> extends never
  ? true
  : never = true;
void _allWorldEvents;

export interface MatchFrame {
  readonly tick: Tick;
  readonly snapshot: Snapshot;
  readonly acks: ReadonlyMap<PlayerId, SeqNo>;
  readonly events: GameEvent[];
}

export interface MatchEvents {
  frame: [frame: MatchFrame];
}

interface PlayerEntry {
  readonly ship: Ship;
  readonly queue: InputMessage[];
  budget: number;
  ack: SeqNo;
  lastSeq: SeqNo;
  clientTick: Tick;
}

export interface MatchOptions {
  room: Room;
  seed?: number;
  now?: () => number;
  ticker?: Partial<Omit<TickerOptions, "onTick">>;
}

const TARGET_ASTEROIDS = 6;
const PICKUP_EVERY_TICKS = 450; // ≈15 с
const MAX_PICKUPS = 2;
// Скільки input можна накопичити в черзі гравця: більше — це або лаг-спайк,
// який вже не варто відтворювати, або спроба засипати сервер.
const MAX_QUEUE = 12;
// «Бюджет» кроків: 1 крок на тик, накопичується до MAX_BUDGET, щоб після
// джитера наздогнати чергу, але не дозволяє прискоритись (speed-hack).
const MAX_BUDGET = 3;

// Авторитетна гра однієї кімнати. Транспорту не знає: на кожному тику
// емітить "frame" { tick, snapshot, acks, events }, а ws.js шле його клієнтам.
//
// Рух корабля відбувається лише коли приходить input гравця (один input =
// один крок integrate). Так клієнт може відтворити стан за seq, і результат
// не залежить від того, коли саме пакет дійшов.
export class Match extends EventEmitter<MatchEvents> {
  readonly room: Room;
  readonly world: World;
  readonly ticker: Ticker;
  rejected = 0; // input, відкинуті валідацією черги/seq
  readonly #players = new Map<PlayerId, PlayerEntry>();
  #events: GameEvent[] = [];

  constructor({ room, seed, now, ticker = {} }: MatchOptions) {
    super();
    this.room = room;
    this.world = new World({
      arena: room.arena,
      seed: seed ?? hashSeed(room.id),
    });
    this.ticker = new Ticker({
      onTick: () => this.tick(),
      ...(now ? { now } : {}),
      ...ticker,
    });
    this.#populate();

    for (const type of WORLD_EVENT_TYPES) {
      this.world.on(type, (d) => {
        this.#events.push({ kind: EVENT_KIND[type], id: d.id, x: d.x, y: d.y });
      });
    }
  }

  get seed(): number {
    return this.world.seed;
  }

  get playerCount(): number {
    return this.#players.size;
  }

  #populate(): void {
    for (let i = 0; i < TARGET_ASTEROIDS; i++) this.#spawnAsteroid(i === 0);
  }

  #spawnAsteroid(homing = false): void {
    const { width, height } = this.world.arena;
    const rng = this.world.rng;
    // З краю арени, щоб не з'являтись на кораблі.
    const edge = rng() < 0.5;
    const x = edge ? 0 : rng() * width;
    const y = edge ? rng() * height : 0;
    this.world.spawn(new Asteroid(x, y, 18 + rng() * 14, { homing, rng }));
  }

  addPlayer(player: Pick<Player, "id">): Ship {
    const spot = this.world.findSafeSpot(SHIP.radius * 6);
    const ship = this.world.spawn(
      new Ship(spot.x, spot.y, { playerId: player.id }),
    );
    ship.invulnerableTicks = SHIP.invulnerableTicks;
    this.#players.set(player.id, {
      ship,
      queue: [],
      budget: 0,
      ack: SEQ_ZERO,
      lastSeq: SEQ_ZERO,
      clientTick: TICK_ZERO,
    });
    return ship;
  }

  removePlayer(id: PlayerId): void {
    const entry = this.#players.get(id);
    if (!entry) return;
    this.world.despawn(entry.ship.id);
    this.#players.delete(id);
  }

  // Приймає ПЕРЕВІРЕНИЙ input. Дублікати та «старі» seq ігноруємо: seq мусить
  // строго зростати (так само, як у клієнта).
  receiveInput(id: PlayerId, input: InputMessage): boolean {
    const entry = this.#players.get(id);
    if (!entry) return false;
    if (input.seq <= entry.lastSeq || entry.queue.length >= MAX_QUEUE) {
      this.rejected++;
      return false;
    }
    entry.lastSeq = input.seq;
    entry.clientTick = input.tick;
    entry.queue.push(input);
    return true;
  }

  start(): void {
    this.ticker.start();
  }

  stop(): void {
    this.ticker.stop();
  }

  // Один крок сервера: input гравців -> крок світу -> спавн -> кадр.
  tick(): void {
    for (const entry of this.#players.values()) {
      entry.budget = Math.min(MAX_BUDGET, entry.budget + 1);
      while (entry.budget >= 1 && entry.queue.length > 0) {
        const input = entry.queue.shift();
        if (!input) break;
        entry.ship.applyInput(input, this.world);
        entry.ack = input.seq;
        entry.budget -= 1;
      }
    }

    this.world.step();
    this.#spawner();

    const events = this.#events;
    this.#events = [];
    const acks = new Map<PlayerId, SeqNo>();
    for (const [id, entry] of this.#players) acks.set(id, entry.ack);
    this.emit("frame", {
      tick: tick(this.world.tick),
      snapshot: this.world.snapshot(),
      acks,
      events,
    });
  }

  #spawner(): void {
    let rocks = 0;
    let pickups = 0;
    for (const e of this.world) {
      if (e.kind === "asteroid") rocks++;
      else if (e.kind === "pickup") pickups++;
    }
    if (rocks < TARGET_ASTEROIDS && this.world.tick % 30 === 0) {
      this.#spawnAsteroid();
    }
    if (pickups < MAX_PICKUPS && this.world.tick % PICKUP_EVERY_TICKS === 0) {
      const { width, height } = this.world.arena;
      const rng = this.world.rng;
      const type =
        PICKUP_TYPES[Math.floor(rng() * PICKUP_TYPES.length)] ??
        PICKUP_TYPES[0];
      this.world.spawn(new Pickup(rng() * width, rng() * height, type));
    }
  }

  stats() {
    return {
      room: this.room.id,
      players: this.playerCount,
      tick: this.world.tick,
      entities: this.world.size,
      rejectedInputs: this.rejected,
      ticker: this.ticker.stats(),
    };
  }
}

// Стабільний seed із назви кімнати (FNV-1a): та сама кімната — той самий світ.
function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
