import { DT, TICK_MS } from "../constants.ts";
import { lerpAngle } from "../sim/vector.ts";
import type { EntityId, Arena } from "../types.ts";
import type { EntityRecord } from "../sim/entity.ts";
import { lerpWrap, wrapInto } from "./geometry.ts";

// Снапшот у буфері: записи плюс індекс за id і час прибуття.
export interface BufferedSnapshot {
  readonly tick: number;
  readonly ack: number;
  readonly entities: readonly EntityRecord[];
  readonly byId: ReadonlyMap<EntityId, EntityRecord>;
  readonly recvMs: number;
}

export type SampleMode = "empty" | "early" | "interpolating" | "extrapolating";

export interface Sample {
  readonly entities: EntityRecord[];
  readonly mode: SampleMode;
}

export interface SnapshotInput {
  readonly tick: number;
  readonly ack: number;
  readonly entities: readonly EntityRecord[];
}

// Буфер снапшотів для інтерполяції чужих сутностей. Малюємо їх у МИНУЛОМУ:
// беремо пару снапшотів, що охоплюють renderTick = (серверний «зараз») − delay.
export class SnapshotBuffer {
  readonly maxSnapshots: number;
  readonly snaps: BufferedSnapshot[] = []; // за зростанням tick

  constructor({ maxSnapshots = 64 }: { maxSnapshots?: number } = {}) {
    this.maxSnapshots = maxSnapshots;
  }

  get latest(): BufferedSnapshot | null {
    return this.snaps.at(-1) ?? null;
  }

  // false, якщо снапшот дублікат (затримані/перевпорядковані пакети можуть
  // прийти двічі або пізно).
  push(snapshot: SnapshotInput, recvMs = 0): boolean {
    const { snaps } = this;
    let i = snaps.length;
    while (i > 0 && (snaps[i - 1]?.tick ?? 0) > snapshot.tick) i--;
    if (i > 0 && snaps[i - 1]?.tick === snapshot.tick) return false;

    const byId = new Map<EntityId, EntityRecord>();
    for (const e of snapshot.entities) byId.set(e.id, e);
    snaps.splice(i, 0, {
      tick: snapshot.tick,
      ack: snapshot.ack,
      entities: snapshot.entities,
      byId,
      recvMs,
    });
    if (snaps.length > this.maxSnapshots) snaps.shift();
    return true;
  }

  // Повертає { entities, mode }. mode: empty | early | interpolating |
  // extrapolating — для netgraph.
  sample(
    renderTick: number,
    arena: Arena,
    { maxExtrapolateTicks = 4 }: { maxExtrapolateTicks?: number } = {},
  ): Sample {
    const { snaps } = this;
    const first = snaps[0];
    if (!first) return { entities: [], mode: "empty" };

    if (renderTick <= first.tick) {
      return { entities: first.entities.map((e) => ({ ...e })), mode: "early" };
    }

    let i = snaps.length - 1;
    while (i > 0 && (snaps[i]?.tick ?? 0) > renderTick) i--;
    const from = snaps[i];
    const to = snaps[i + 1];
    if (!from) return { entities: [], mode: "empty" };

    if (!to) {
      // Нових снапшотів немає: коротко екстраполюємо за швидкістю.
      const ticks = Math.min(renderTick - from.tick, maxExtrapolateTicks);
      const entities = from.entities.map((e) => ({
        ...e,
        x: wrapInto(e.x + e.vx * DT * ticks, arena.width),
        y: wrapInto(e.y + e.vy * DT * ticks, arena.height),
      }));
      return { entities, mode: "extrapolating" };
    }

    const t = (renderTick - from.tick) / (to.tick - from.tick);
    const entities: EntityRecord[] = [];
    for (const a of from.entities) {
      const b = to.byId.get(a.id);
      if (!b) {
        // Зникне в `to`: до того моменту малюємо останній відомий стан.
        entities.push({ ...a });
        continue;
      }
      entities.push({
        ...b,
        x: lerpWrap(a.x, b.x, t, arena.width),
        y: lerpWrap(a.y, b.y, t, arena.height),
        angle: lerpAngle(a.angle, b.angle, t),
      });
    }
    // Сутності, що з'явились у `to`, ще не малюємо: вони постануть, коли
    // renderTick дійде до `to`.
    return { entities, mode: "interpolating" };
  }
}

// Оцінка серверного годинника за часом прибуття снапшотів. Для кожного
// снапшота рахуємо (час прибуття − tick·TICK_MS); мінімум за вікно — це
// «найшвидший» шлях, тож джитер мережі не смикає час рендеру.
export class ServerClock {
  readonly windowMs: number;
  readonly gain: number;
  readonly samples: { at: number; value: number }[] = [];
  offset: number | null = null;

  constructor({ windowMs = 5000, gain = 0.1 }: { windowMs?: number; gain?: number } = {}) {
    this.windowMs = windowMs;
    this.gain = gain;
  }

  get ready(): boolean {
    return this.offset !== null;
  }

  observe(tick: number, recvMs: number): void {
    const value = recvMs - tick * TICK_MS;
    this.samples.push({ at: recvMs, value });
    for (let first = this.samples[0]; first && recvMs - first.at > this.windowMs; first = this.samples[0]) {
      this.samples.shift();
    }
    let target = Number.POSITIVE_INFINITY;
    for (const s of this.samples) target = Math.min(target, s.value);
    // Повільно підтягуємо оцінку до мінімуму, щоб час не стрибав.
    this.offset =
      this.offset === null ? target : this.offset + (target - this.offset) * this.gain;
  }

  // Оцінка поточного тику сервера (дробове).
  serverTickAt(nowMs: number): number {
    return (nowMs - (this.offset ?? 0)) / TICK_MS;
  }
}
