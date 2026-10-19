import { wrapBounds } from "./arena.js";
import { findCollisions, resolvePair } from "./collision.js";
import { Vector2 } from "./vector.js";

// Симуляція не знає ні про DOM, ні про звук, ні про HUD: назовні вона
// повідомляє лише подіями (fired, hit, exploded) через world.events.
export class World {
  #entities = new Map();

  constructor({
    arena = { width: 1200, height: 800 },
    rng = Math.random,
    collisions = findCollisions,
  } = {}) {
    this.arena = arena;
    this.rng = rng;
    this.collisions = collisions;
    this.events = new EventTarget();
  }

  emit(type, detail) {
    this.events.dispatchEvent(new CustomEvent(type, { detail }));
  }

  spawn(entity) {
    this.#entities.set(entity.id, entity);
    return entity;
  }

  // Відкладене видалення: лише позначаємо, прибирає step() наприкінці.
  despawn(id) {
    const entity = this.#entities.get(id);
    if (entity) entity.alive = false;
  }

  get(id) {
    return id == null ? undefined : this.#entities.get(id);
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
    let bestGap = -Infinity;

    for (let attempt = 0; attempt < 24; attempt++) {
      const candidate = new Vector2(
        this.rng() * width,
        this.rng() * height,
      );
      let gap = Infinity;
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

  step(dt, input) {
    for (const entity of this.#entities.values()) {
      entity.savePrev();
    }

    for (const entity of this.#entities.values()) {
      if (!entity.alive) continue;
      entity.update(dt, this, input);
      wrapBounds(entity, this.arena.width, this.arena.height);
    }

    for (const [a, b] of this.collisions(this)) {
      resolvePair(a, b, this);
    }

    for (const [id, entity] of this.#entities) {
      if (!entity.alive) this.#entities.delete(id);
    }
  }
}
