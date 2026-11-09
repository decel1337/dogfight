import { DEFAULT_ARENA } from "../constants.ts";
import { Emitter } from "../emitter.ts";
import { mulberry32 as createRng, type Rng } from "../prng.ts";
import { type Arena, type EntityId, entityId } from "../types.ts";
import { wrapBounds } from "./arena.ts";
import {
  type CollisionFinder,
  findCollisions,
  resolvePair,
} from "./collision.ts";
import {
  type AnyEntity,
  Bullet,
  entityFromRecord,
  isKind,
  type Ship,
} from "./entities.ts";
import type { EntityKind, EntityOf, EntityRecord } from "./entity.ts";
import { Vector2 } from "./vector.ts";

const MAX_ID = 0xffff;

// Авторитетний світ. Не знає ні про DOM, ні про звук, ні про мережу: назовні
// повідомляє подіями (fired, hit, exploded) через world.on().
// «Випадковість» — тільки з world.rng (seed), годинника тут немає взагалі.
// Події світу: назва -> що саме відбулося (позиція — для ефектів і звуку).
export interface WorldEvents {
  fired: { readonly id: EntityId; readonly x: number; readonly y: number };
  hit: { readonly id: EntityId; readonly x: number; readonly y: number };
  exploded: { readonly id: EntityId; readonly x: number; readonly y: number };
}

export interface WorldOptions {
  arena?: Arena;
  seed?: number;
  collisions?: CollisionFinder;
}

export interface Snapshot {
  readonly tick: number;
  readonly entities: EntityRecord[];
}

export class World {
  readonly #entities = new Map<EntityId, AnyEntity>();
  readonly #events = new Emitter<WorldEvents>();
  #nextId = 1;
  readonly arena: Arena;
  readonly seed: number;
  readonly rng: Rng;
  readonly collisions: CollisionFinder;
  tick = 0;

  constructor({
    arena = DEFAULT_ARENA,
    seed = 1,
    collisions = findCollisions,
  }: WorldOptions = {}) {
    this.arena = arena;
    this.seed = seed >>> 0;
    this.rng = createRng(this.seed);
    this.collisions = collisions;
  }

  // Типізовані події: handler отримує саме той payload, що відповідає type.
  on<K extends keyof WorldEvents>(
    type: K,
    handler: (detail: WorldEvents[K]) => void,
  ): () => void {
    return this.#events.on(type, handler);
  }

  emit<K extends keyof WorldEvents>(type: K, detail: WorldEvents[K]): void {
    this.#events.emit(type, detail);
  }

  #allocId(): EntityId {
    for (let i = 0; i < MAX_ID; i++) {
      const id = this.#nextId;
      this.#nextId = (this.#nextId % MAX_ID) + 1;
      if (!this.#entities.has(entityId(id))) return entityId(id);
    }
    throw new Error("закінчились id сутностей (u16)");
  }

  spawn<E extends AnyEntity>(entity: E): E {
    entity.id = this.#allocId();
    this.#entities.set(entity.id, entity);
    return entity;
  }

  // Відкладене видалення: лише позначаємо, прибирає step() наприкінці.
  despawn(id: EntityId): void {
    const entity = this.#entities.get(id);
    if (entity) entity.alive = false;
  }

  get(id: EntityId): AnyEntity | undefined {
    return this.#entities.get(id);
  }

  getShip(id: EntityId): Ship | undefined {
    const entity = this.#entities.get(id);
    return entity && isKind(entity, "ship") ? entity : undefined;
  }

  get size(): number {
    return this.#entities.size;
  }

  *[Symbol.iterator](): Generator<AnyEntity> {
    yield* this.#entities.values();
  }

  *ofKind<K extends EntityKind>(kind: K): Generator<EntityOf<K>> {
    for (const entity of this.#entities.values()) {
      if (isKind(entity, kind)) yield entity;
    }
  }

  // Місце, достатньо далеке від астероїдів, для респавну.
  findSafeSpot(clearance: number): Vector2 {
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
  step(): void {
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
      if (!entity.alive) {
        this.#entities.delete(id);
        // Мертва куля повертається в пул; id вільний для нових сутностей.
        if (isKind(entity, "bullet")) Bullet.release(entity);
      }
    }
  }

  // Плоский снапшот реплікованого стану.
  snapshot(): Snapshot {
    const entities: EntityRecord[] = [];
    for (const entity of this.#entities.values()) {
      if (entity.alive) entities.push(entity.toSnapshot());
    }
    return { tick: this.tick, entities };
  }

  // Відновлення світу зі снапшота (для тестів і інструментів). Нові id
  // зберігаються як у записах.
  static fromSnapshot(snapshot: Snapshot, options: WorldOptions = {}): World {
    const world = new World(options);
    world.tick = snapshot.tick;
    for (const rec of snapshot.entities) {
      const entity = entityFromRecord(rec);
      world.#entities.set(entity.id, entity);
    }
    return world;
  }
}
