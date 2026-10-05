import { wrapBounds } from "./arena.js";
import { checkCollisions } from "./collision.js";

export class World {
  #entities = new Map();

  spawn(entity) {
    this.#entities.set(entity.id, entity);
    return entity;
  }

  despawn(id) {
    const e = this.#entities.get(id);
    if (e) e.alive = false;
  }

  get(id) {
    return this.#entities.get(id);
  }

  *[Symbol.iterator]() {
    yield* this.#entities.values();
  }

  *ofKind(kind) {
    for (const e of this) {
      if (e.kind === kind) yield e;
    }
  }

  step(dt, input, bounds) {
    // 1. Оновлюємо кожну сутність
    for (const entity of this.#entities.values()) {
      if (!entity.alive && entity.kind !== "ship") continue;
      entity.update(dt, this, entity.kind === "ship" ? input : undefined);
      wrapBounds(entity, bounds.width, bounds.height);
    }

    // 2. Рахуємо колізії
    checkCollisions(this);

    // 3. Відкладене прибирання "мертвих" сутностей (Sweep phase)
    for (const [id, entity] of this.#entities.entries()) {
      if (!entity.alive && entity.kind !== "ship") {
        this.#entities.delete(id);
      }
    }
  }
}
