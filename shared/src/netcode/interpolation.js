import { DT, TICK_MS } from "../constants.js";
import { lerpAngle } from "../sim/vector.js";
import { lerpWrap, wrapInto } from "./geometry.js";

// Буфер снапшотів для інтерполяції чужих сутностей. Малюємо їх у МИНУЛОМУ:
// беремо пару снапшотів, що охоплюють renderTick = (серверний «зараз») − delay.
export class SnapshotBuffer {
  constructor({ maxSnapshots = 64 } = {}) {
    this.maxSnapshots = maxSnapshots;
    this.snaps = []; // за зростанням tick
  }

  get latest() {
    return this.snaps.at(-1) ?? null;
  }

  // false, якщо снапшот дублікат (затримані/перевпорядковані пакети можуть
  // прийти двічі або пізно).
  push(snapshot, recvMs = 0) {
    const { snaps } = this;
    let i = snaps.length;
    while (i > 0 && snaps[i - 1].tick > snapshot.tick) i--;
    if (i > 0 && snaps[i - 1].tick === snapshot.tick) return false;

    const byId = new Map();
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
  sample(renderTick, arena, { maxExtrapolateTicks = 4 } = {}) {
    const { snaps } = this;
    if (snaps.length === 0) return { entities: [], mode: "empty" };

    if (renderTick <= snaps[0].tick) {
      return {
        entities: snaps[0].entities.map((e) => ({ ...e })),
        mode: "early",
      };
    }

    let i = snaps.length - 1;
    while (i > 0 && snaps[i].tick > renderTick) i--;
    const from = snaps[i];

    if (i === snaps.length - 1) {
      // Нових снапшотів немає: коротко екстраполюємо за швидкістю.
      const ticks = Math.min(renderTick - from.tick, maxExtrapolateTicks);
      const entities = from.entities.map((e) => ({
        ...e,
        x: wrapInto(e.x + e.vx * DT * ticks, arena.width),
        y: wrapInto(e.y + e.vy * DT * ticks, arena.height),
      }));
      return { entities, mode: "extrapolating" };
    }

    const to = snaps[i + 1];
    const t = (renderTick - from.tick) / (to.tick - from.tick);
    const entities = [];
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
  constructor({ windowMs = 5000, gain = 0.1 } = {}) {
    this.windowMs = windowMs;
    this.gain = gain;
    this.samples = [];
    this.offset = null;
  }

  get ready() {
    return this.offset !== null;
  }

  observe(tick, recvMs) {
    const value = recvMs - tick * TICK_MS;
    this.samples.push({ at: recvMs, value });
    while (
      this.samples.length > 0 &&
      recvMs - this.samples[0].at > this.windowMs
    ) {
      this.samples.shift();
    }
    let target = Number.POSITIVE_INFINITY;
    for (const s of this.samples) target = Math.min(target, s.value);
    // Повільно підтягуємо оцінку до мінімуму, щоб час не стрибав.
    this.offset =
      this.offset === null
        ? target
        : this.offset + (target - this.offset) * this.gain;
  }

  // Оцінка поточного тику сервера (дробове).
  serverTickAt(nowMs) {
    return (nowMs - this.offset) / TICK_MS;
  }
}
