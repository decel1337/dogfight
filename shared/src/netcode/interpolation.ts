import { DT, TICK_MS } from "../constants.ts";
import type { EntityRecord } from "../sim/entity.ts";
import { lerpAngle } from "../sim/vector.ts";
import type { Arena, EntityId, SeqNo, Tick } from "../types.ts";
import { lerpWrap, wrapInto } from "./geometry.ts";

// Снапшот у буфері: записи плюс індекс за id і час прибуття.
export interface BufferedSnapshot {
  readonly tick: Tick;
  readonly ack: SeqNo;
  readonly entities: readonly EntityRecord[];
  readonly byId: ReadonlyMap<EntityId, EntityRecord>;
  readonly recvMs: number;
}

export type SampleMode = "empty" | "early" | "interpolating" | "extrapolating";

export interface Sample {
  readonly entities: EntityRecord[];
  readonly mode: SampleMode;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

// Пул для sampleInto: записи й масив живуть між кадрами, тож 60 кадрів/с не
// створюють ні масивів, ні об'єктів-записів (див. README, «Lab 07 / M3»).
// УВАГА: після наступного sampleInto попередній результат перезаписується.
export class SampleScratch {
  readonly pool: Mutable<EntityRecord>[] = [];
  readonly entities: EntityRecord[] = [];
  mode: SampleMode = "empty";

  // Наступний вільний запис пулу, заповнений копією `src` (поля x/y/angle
  // викликач перезапише при інтерполяції).
  take(src: EntityRecord): Mutable<EntityRecord> {
    const n = this.entities.length;
    let rec = this.pool[n];
    if (!rec) {
      rec = { ...src };
      this.pool[n] = rec;
    } else {
      rec.id = src.id;
      rec.kind = src.kind;
      rec.flags = src.flags;
      rec.x = src.x;
      rec.y = src.y;
      rec.vx = src.vx;
      rec.vy = src.vy;
      rec.angle = src.angle;
      rec.a = src.a;
      rec.b = src.b;
      rec.c = src.c;
    }
    this.entities.push(rec);
    return rec;
  }
}

export interface SnapshotInput {
  readonly tick: Tick;
  readonly ack: SeqNo;
  readonly entities: readonly EntityRecord[];
}

// Буфер снапшотів для інтерполяції чужих сутностей. Малюємо їх у МИНУЛОМУ:
// беремо пару снапшотів, що охоплюють renderTick = (серверний «зараз») − delay.
export class SnapshotBuffer {
  readonly maxSnapshots: number;
  readonly snaps: BufferedSnapshot[] = []; // за зростанням tick

  // 12 снапшотів ≈ 0,4 с: з запасом на затримку інтерполяції (2 тики) і
  // перевпорядкування. Було 64 (≈2 с): записи жили довше за інтервал між
  // scavenge, переживали два мінорні GC, потрапляли в old space й змушували
  // V8 робити major GC (див. README, Lab 07 / M3).
  constructor({ maxSnapshots = 12 }: { maxSnapshots?: number } = {}) {
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
  // extrapolating — для netgraph. Кожен виклик створює нові записи (зручно в
  // тестах); гарячий шлях рендеру використовує sampleInto.
  sample(
    renderTick: number,
    arena: Arena,
    { maxExtrapolateTicks = 4 }: { maxExtrapolateTicks?: number } = {},
  ): Sample {
    const scratch = new SampleScratch();
    this.sampleInto(scratch, renderTick, arena, maxExtrapolateTicks);
    return { entities: scratch.entities, mode: scratch.mode };
  }

  // Те саме, але без алокацій у сталому режимі: записи беруться з пулу `scratch`.
  sampleInto(
    scratch: SampleScratch,
    renderTick: number,
    arena: Arena,
    maxExtrapolateTicks = 4,
  ): SampleMode {
    const { snaps } = this;
    const out = scratch.entities;
    out.length = 0;
    const first = snaps[0];
    if (!first) return (scratch.mode = "empty");

    if (renderTick <= first.tick) {
      for (const e of first.entities) scratch.take(e);
      return (scratch.mode = "early");
    }

    let i = snaps.length - 1;
    while (i > 0 && (snaps[i]?.tick ?? 0) > renderTick) i--;
    const from = snaps[i];
    const to = snaps[i + 1];
    if (!from) return (scratch.mode = "empty");

    if (!to) {
      // Нових снапшотів немає: коротко екстраполюємо за швидкістю.
      const ticks = Math.min(renderTick - from.tick, maxExtrapolateTicks);
      for (const e of from.entities) {
        const rec = scratch.take(e);
        rec.x = wrapInto(e.x + e.vx * DT * ticks, arena.width);
        rec.y = wrapInto(e.y + e.vy * DT * ticks, arena.height);
      }
      return (scratch.mode = "extrapolating");
    }

    const t = (renderTick - from.tick) / (to.tick - from.tick);
    for (const a of from.entities) {
      const b = to.byId.get(a.id);
      if (!b) {
        // Зникне в `to`: до того моменту малюємо останній відомий стан.
        scratch.take(a);
        continue;
      }
      const rec = scratch.take(b);
      rec.x = lerpWrap(a.x, b.x, t, arena.width);
      rec.y = lerpWrap(a.y, b.y, t, arena.height);
      rec.angle = lerpAngle(a.angle, b.angle, t);
    }
    // Сутності, що з'явились у `to`, ще не малюємо: вони постануть, коли
    // renderTick дійде до `to`.
    return (scratch.mode = "interpolating");
  }
}

// Оцінка серверного годинника за часом прибуття снапшотів. Для кожного
// снапшота рахуємо (час прибуття − tick·TICK_MS); мінімум за вікно — це
// «найшвидший» шлях, тож джитер мережі не смикає час рендеру.
export class ServerClock {
  readonly windowMs: number;
  readonly gain: number;
  offset: number | null = null;

  // Кільце з двох Float64Array замість масиву об'єктів {at, value}: раніше 150
  // живих об'єктів на 5-секундне вікно щосекунди переходили в old space.
  readonly #at = new Float64Array(512);
  readonly #value = new Float64Array(512);
  #head = 0; // індекс найстарішого
  #count = 0;

  constructor({
    windowMs = 5000,
    gain = 0.1,
  }: { windowMs?: number; gain?: number } = {}) {
    this.windowMs = windowMs;
    this.gain = gain;
  }

  get ready(): boolean {
    return this.offset !== null;
  }

  get sampleCount(): number {
    return this.#count;
  }

  observe(tick: Tick, recvMs: number): void {
    const cap = this.#at.length;
    if (this.#count === cap) {
      this.#head = (this.#head + 1) % cap; // переповнення: відкидаємо найстаріший
      this.#count--;
    }
    const slot = (this.#head + this.#count) % cap;
    this.#at[slot] = recvMs;
    this.#value[slot] = recvMs - tick * TICK_MS;
    this.#count++;
    while (
      this.#count > 0 &&
      recvMs - (this.#at[this.#head] ?? 0) > this.windowMs
    ) {
      this.#head = (this.#head + 1) % cap;
      this.#count--;
    }
    let target = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.#count; i++) {
      target = Math.min(
        target,
        this.#value[(this.#head + i) % cap] ?? Number.POSITIVE_INFINITY,
      );
    }
    // Повільно підтягуємо оцінку до мінімуму, щоб час не стрибав.
    this.offset =
      this.offset === null
        ? target
        : this.offset + (target - this.offset) * this.gain;
  }

  // Оцінка поточного тику сервера (дробове).
  serverTickAt(nowMs: number): number {
    return (nowMs - (this.offset ?? 0)) / TICK_MS;
  }
}
