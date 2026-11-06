import { EventEmitter } from "node:events";
import { SHIP } from "@dogfight/shared/constants";
import {
  Asteroid,
  Pickup,
  PICKUP_TYPES,
  Ship,
  World,
} from "@dogfight/shared/sim";
import { Ticker } from "./ticker.js";

// Коди подій для клієнтів (див. специфікацію бінарного протоколу).
export const EVENT_KIND = Object.freeze({ fired: 1, hit: 2, exploded: 3 });

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
export class Match extends EventEmitter {
  #players = new Map(); // playerId -> { ship, queue, budget, ack, lastSeq }
  #events = [];

  constructor({ room, seed, now, ticker = {} }) {
    super();
    this.room = room;
    this.world = new World({
      arena: room.arena,
      seed: seed ?? hashSeed(room.id),
    });
    this.ticker = new Ticker({ onTick: () => this.tick(), now, ...ticker });
    this.rejected = 0; // input, відкинуті валідацією черги/seq
    this.#populate();

    for (const type of Object.keys(EVENT_KIND)) {
      this.world.on(type, (d) =>
        this.#events.push({ kind: EVENT_KIND[type], id: d.id, x: d.x, y: d.y }),
      );
    }
  }

  get seed() {
    return this.world.seed;
  }

  get playerCount() {
    return this.#players.size;
  }

  #populate() {
    for (let i = 0; i < TARGET_ASTEROIDS; i++) this.#spawnAsteroid(i === 0);
  }

  #spawnAsteroid(homing = false) {
    const { width, height } = this.world.arena;
    const rng = this.world.rng;
    // З краю арени, щоб не з'являтись на кораблі.
    const edge = rng() < 0.5;
    const x = edge ? 0 : rng() * width;
    const y = edge ? rng() * height : 0;
    this.world.spawn(new Asteroid(x, y, 18 + rng() * 14, { homing, rng }));
  }

  addPlayer(player) {
    const spot = this.world.findSafeSpot(SHIP.radius * 6);
    const ship = this.world.spawn(
      new Ship(spot.x, spot.y, { playerId: player.id }),
    );
    ship.invulnerableTicks = SHIP.invulnerableTicks;
    this.#players.set(player.id, {
      ship,
      queue: [],
      budget: 0,
      ack: 0,
      lastSeq: 0,
      clientTick: 0,
    });
    return ship;
  }

  removePlayer(playerId) {
    const entry = this.#players.get(playerId);
    if (!entry) return;
    this.world.despawn(entry.ship.id);
    this.#players.delete(playerId);
  }

  // Приймає ПЕРЕВІРЕНИЙ input. Дублікати та «старі» seq ігноруємо: seq мусить
  // строго зростати (так само, як у клієнта).
  receiveInput(playerId, input) {
    const entry = this.#players.get(playerId);
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

  start() {
    this.ticker.start();
  }

  stop() {
    this.ticker.stop();
  }

  // Один крок сервера: input гравців -> крок світу -> спавн -> кадр.
  tick() {
    for (const entry of this.#players.values()) {
      entry.budget = Math.min(MAX_BUDGET, entry.budget + 1);
      while (entry.budget >= 1 && entry.queue.length > 0) {
        const input = entry.queue.shift();
        entry.ship.applyInput(input, this.world);
        entry.ack = input.seq;
        entry.budget -= 1;
      }
    }

    this.world.step();
    this.#spawner();

    const events = this.#events;
    this.#events = [];
    const acks = new Map();
    for (const [id, entry] of this.#players) acks.set(id, entry.ack);
    this.emit("frame", {
      tick: this.world.tick,
      snapshot: this.world.snapshot(),
      acks,
      events,
    });
  }

  #spawner() {
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
      const type = PICKUP_TYPES[Math.floor(rng() * PICKUP_TYPES.length)];
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
function hashSeed(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
