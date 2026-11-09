import { TICK_MS } from "@dogfight/shared/constants";

export interface TickerOptions {
  onTick: () => void;
  tickMs?: number;
  now?: () => number;
  maxCatchUp?: number;
  window?: number;
}

interface Sample {
  took: number;
  lateness: number;
}

export interface TickerStats {
  ticks: number;
  skipped: number;
  samples: number;
  tickMs?: number;
  workMs?: { avg: number; p99: number; max: number };
  jitterMs?: { avg: number; p99: number; max: number };
}

// Фіксований ігровий такт із АБСОЛЮТНИМИ цілями.
//
// setInterval(fn, 33.3) дрейфує: кожен виклик спізнюється на кілька мс, і
// помилка накопичується. Тут «ідеальний» час наступного тика рахується від
// старту (start + n·TICK_MS), а таймер ставиться на різницю з поточним
// часом. Якщо цикл подій затримався й ми відстали на кілька тиків, робимо
// їх підряд (але не більше maxCatchUp, щоб не впасти в «спіраль смерті»).
export class Ticker {
  readonly onTick: () => void;
  readonly tickMs: number;
  readonly now: () => number;
  readonly maxCatchUp: number;
  readonly window: number;
  ticks = 0;
  skipped = 0;
  #timer: NodeJS.Timeout | null = null;
  #stopped = true;
  #target = 0;
  readonly #samples: Sample[] = [];

  constructor({
    onTick,
    tickMs = TICK_MS,
    now = () => performance.now(),
    maxCatchUp = 5,
    window = 300, // ~10 с історії при 30 Гц
  }: TickerOptions) {
    this.onTick = onTick;
    this.tickMs = tickMs;
    this.now = now;
    this.maxCatchUp = maxCatchUp;
    this.window = window;
  }

  get running(): boolean {
    return !this.#stopped;
  }

  start(): void {
    if (this.#timer !== null) return;
    this.#stopped = false;
    this.#target = this.now() + this.tickMs;
    this.#schedule();
  }

  stop(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#stopped = true;
  }

  #schedule(): void {
    const delay = Math.max(0, this.#target - this.now());
    this.#timer = setTimeout(() => this.#run(), delay);
  }

  #run(): void {
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

  #record(took: number, lateness: number): void {
    this.#samples.push({ took, lateness });
    if (this.#samples.length > this.window) this.#samples.shift();
  }

  // Статистика для /api/stats: тривалість тика та «тремтіння» таймера.
  stats(): TickerStats {
    const n = this.#samples.length;
    if (n === 0) {
      return { ticks: this.ticks, skipped: this.skipped, samples: 0 };
    }
    const took = this.#samples.map((s) => s.took).sort((a, b) => a - b);
    const late = this.#samples.map((s) => s.lateness).sort((a, b) => a - b);
    const avg = (xs: number[]): number =>
      xs.reduce((a, b) => a + b, 0) / xs.length;
    const q = (xs: number[], p: number): number =>
      xs[Math.min(xs.length - 1, Math.floor(xs.length * p))] ?? 0;
    const round = (v: number): number => Math.round(v * 1000) / 1000;
    return {
      ticks: this.ticks,
      skipped: this.skipped,
      samples: n,
      tickMs: this.tickMs,
      workMs: {
        avg: round(avg(took)),
        p99: round(q(took, 0.99)),
        max: round(took[n - 1] ?? 0),
      },
      jitterMs: {
        avg: round(avg(late)),
        p99: round(q(late, 0.99)),
        max: round(late[n - 1] ?? 0),
      },
    };
  }
}
