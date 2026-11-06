import { DEFAULT_ARENA } from "../constants.js";
import { mulberry32 as createRng } from "../prng.js";
import { wrapBounds } from "./arena.js";
import { findCollisions, resolvePair } from "./collision.js";
import { ENTITY_CLASSES } from "./entities.js";
import { Vector2 } from "./vector.js";

const MAX_ID = 0xffff;

// Авторитетний світ. Не знає ні про DOM, ні про звук, ні про мережу: назовні
// повідомляє подіями (fired, hit, exploded) через world.on().
// «Випадковість» — тільки з world.rng (seed), годинника тут немає взагалі.
export class World {
  #entities = new Map();
  #nextId = 1;
  #listeners = new Map();

  constructor({
    arena = DEFAULT_ARENA,
    seed = 1,
    collisions = findCollisions,
  } = {}) {
    this.arena = arena;
    this.seed = seed >>> 0;
    this.rng = createRng(this.seed);
    this.collisions = collisions;
    this.tick = 0;
  }

  on(type, handler) {
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
    this.#listeners.get(type).add(handler);
    return () => this.#listeners.get(type)?.delete(handler);
  }

  emit(type, detail) {
    for (const handler of this.#listeners.get(type) ?? []) handler(detail);
  }

  #allocId() {
    for (let i = 0; i < MAX_ID; i++) {
      const id = this.#nextId;
      this.#nextId = (this.#nextId % MAX_ID) + 1;
      if (!this.#entities.has(id)) return id;
    }
    throw new Error("закінчились id сутностей (u16)");
  }

  spawn(entity) {
    entity.id = this.#allocId();
    this.#entities.set(entity.id, entity);
    return entity;
  }

  // Відкладене видалення: лише позначаємо, прибирає step() наприкінці.
  despawn(id) {
    const entity = this.#entities.get(id);
    if (entity) entity.alive = false;
  }

  get(id) {
    return this.#entities.get(id);
  }

  get size() {
    return this.#entities.size;
  }

  *[Symbol.iterator]() {
    yield* this.#entities.values();
  }

  *ofKind(kind) {
    for (const entity of this.#entities.values()) {
      if (entity.kind === kind) yield entity;
    }
  }

  // Місце, достатньо далеке від астероїдів, для респавну.
  findSafeSpot(clearance) {
    const { width, height } = this.arena;
    let best = new Vector2(width / 2, height / 2);
    let bestGap = Number.NEGATIVE_INFINITY;

    for (let attempt = 0; attempt < 24; attempt++) {
      const candidate = new Vector2(this.rng() * width, this.rng() * height);
      let gap = Number.POSITIVE_INFINITY;
      for (const rock of this.ofKind("asteroid")) {
        gap = Math.min(gap, candidate.dist(rock.pos) - rock.radius);
      }
      if (gap >= clearance) return candidate;
      if (gap > bestGap) {
        bestGap = gap;
        best = candidate;
      }
    }
    return best;
  }

  // Один крок фіксованої тривалості DT. Рух кораблів сюди не входить: його
  // робить Ship.applyInput, коли надходять input (див. Match на сервері).
  step() {
    this.tick++;

    for (const entity of this.#entities.values()) {
      if (!entity.alive) continue;
      entity.update(this);
      wrapBounds(entity, this.arena.width, this.arena.height);
    }

    for (const [a, b] of this.collisions(this)) {
      resolvePair(a, b, this);
    }

    for (const [id, entity] of this.#entities) {
      if (!entity.alive) this.#entities.delete(id);
    }
  }

  // Плоский снапшот реплікованого стану.
  snapshot() {
    const entities = [];
    for (const entity of this.#entities.values()) {
      if (entity.alive) entities.push(entity.toSnapshot());
    }
    return { tick: this.tick, entities };
  }

  // Відновлення світу зі снапшота (для тестів і інструментів). Нові id
  // зберігаються як у записах.
  static fromSnapshot(snapshot, options = {}) {
    const world = new World(options);
    world.tick = snapshot.tick;
    for (const rec of snapshot.entities) {
      const entity = ENTITY_CLASSES[rec.kind].fromSnapshot(rec);
      world.#entities.set(entity.id, entity);
    }
    return world;
  }
}
