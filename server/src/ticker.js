import { TICK_MS } from "@dogfight/shared/constants";

// Фіксований ігровий такт із АБСОЛЮТНИМИ цілями.
//
// setInterval(fn, 33.3) дрейфує: кожен виклик спізнюється на кілька мс, і
// помилка накопичується. Тут «ідеальний» час наступного тика рахується від
// старту (start + n·TICK_MS), а таймер ставиться на різницю з поточним
// часом. Якщо цикл подій затримався й ми відстали на кілька тиків, робимо
// їх підряд (але не більше maxCatchUp, щоб не впасти в «спіраль смерті»).
export class Ticker {
  #timer = null;
  #stopped = true;
  #target = 0;
  #samples = [];

  constructor({
    onTick,
    tickMs = TICK_MS,
    now = () => performance.now(),
    maxCatchUp = 5,
    window = 300, // ~10 с історії при 30 Гц
  }) {
    this.onTick = onTick;
    this.tickMs = tickMs;
    this.now = now;
    this.maxCatchUp = maxCatchUp;
    this.window = window;
    this.ticks = 0;
    this.skipped = 0;
  }

  get running() {
    return !this.#stopped;
  }

  start() {
    if (this.#timer !== null) return;
    this.#stopped = false;
    this.#target = this.now() + this.tickMs;
    this.#schedule();
  }

  stop() {
    clearTimeout(this.#timer);
    this.#timer = null;
    this.#stopped = true;
  }

  #schedule() {
    const delay = Math.max(0, this.#target - this.now());
    this.#timer = setTimeout(() => this.#run(), delay);
  }

  #run() {
    this.#timer = null;
    let t = this.now();
    // lateness — наскільки пізніше за ідеальний час спрацював таймер
    const lateness = t - this.#target;

    let done = 0;
    while (t >= this.#target && done < this.maxCatchUp) {
      const began = this.now();
      this.onTick();
      const took = this.now() - began;
      this.#record(took, done === 0 ? Math.max(0, lateness) : 0);
      this.#target += this.tickMs;
      this.ticks++;
      done++;
      t = this.now();
      if (this.#stopped) return;
    }
    // Не наздогнали за maxCatchUp: відкидаємо борг, щоб не накопичувати.
    if (t >= this.#target) {
      const behind = Math.floor((t - this.#target) / this.tickMs) + 1;
      this.skipped += behind;
      this.#target += behind * this.tickMs;
    }
    if (!this.#stopped) this.#schedule();
  }

  #record(took, lateness) {
    this.#samples.push({ took, lateness });
    if (this.#samples.length > this.window) this.#samples.shift();
  }

  // Статистика для /api/stats: тривалість тика та «тремтіння» таймера.
  stats() {
    const n = this.#samples.length;
    if (n === 0) {
      return { ticks: this.ticks, skipped: this.skipped, samples: 0 };
    }
    const took = this.#samples.map((s) => s.took).sort((a, b) => a - b);
    const late = this.#samples.map((s) => s.lateness).sort((a, b) => a - b);
    const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const q = (xs, p) => xs[Math.min(xs.length - 1, Math.floor(xs.length * p))];
    const round = (v) => Math.round(v * 1000) / 1000;
    return {
      ticks: this.ticks,
      skipped: this.skipped,
      samples: n,
      tickMs: this.tickMs,
      workMs: {
        avg: round(avg(took)),
        p99: round(q(took, 0.99)),
        max: round(took[n - 1]),
      },
      jitterMs: {
        avg: round(avg(late)),
        p99: round(q(late, 0.99)),
        max: round(late[n - 1]),
      },
    };
  }
}
