// Імітатор поганої мережі для ОДНОГО з'єднання (на стороні сервера, тож
// працює однаково для будь-якого клієнта й не залежить від браузера).
//
//  latency — RTT, мс. Кожен напрямок отримує latency/2.
//  jitter  — розкид, мс: затримка напрямку = latency/2 ± jitter/2 (рівномірно).
//  drop    — % втрат (лише для ненадійних повідомлень).
//
// Два класи доставки, як у реальних транспортів:
//  reliable   (чат, roster, joined) — TCP-подібно: не губиться, порядок
//             збережено (кожне наступне не раніше попереднього);
//  unreliable (input, snapshot, ping) — UDP-подібно: може губитись і
//             перегоняти одне одного.
// WebSocket поверх TCP сам нічого не губить, тому втрати й перестановку
// моделюємо тут свідомо: це те, що побачив би клієнт на UDP/WebRTC.
export interface NetSimConfig {
  latency?: number;
  jitter?: number;
  drop?: number;
}

export class NetSim {
  readonly now: () => number;
  readonly rng: () => number;
  latency = 0;
  jitter = 0;
  drop = 0;
  sent = 0;
  dropped = 0;
  #pendingReliable = 0;
  #lastReliableAt = 0;
  readonly #timers = new Set<NodeJS.Timeout>();

  constructor({
    now = () => performance.now(),
    rng = Math.random,
  }: { now?: () => number; rng?: () => number } = {}) {
    this.now = now;
    this.rng = rng;
  }

  get active(): boolean {
    return this.latency > 0 || this.jitter > 0 || this.drop > 0;
  }

  configure({ latency = 0, jitter = 0, drop = 0 }: NetSimConfig): void {
    this.latency = latency;
    this.jitter = jitter;
    this.drop = drop;
  }

  // Затримка одного напрямку, мс.
  #delay(): number {
    const base = this.latency / 2;
    const spread = (this.rng() - 0.5) * this.jitter;
    return Math.max(0, base + spread);
  }

  // Пропускає виклик fn крізь «мережу». Повертає false, якщо пакет втрачено.
  pass(
    fn: () => void,
    { reliable = false }: { reliable?: boolean } = {},
  ): boolean {
    this.sent++;
    if (!reliable && this.drop > 0 && this.rng() * 100 < this.drop) {
      this.dropped++;
      return false;
    }
    if (!this.active && this.#pendingReliable === 0) {
      fn();
      return true;
    }

    let at = this.now() + this.#delay();
    if (reliable) {
      at = Math.max(at, this.#lastReliableAt); // FIFO
      this.#lastReliableAt = at;
      this.#pendingReliable++;
    }
    const timer = setTimeout(
      () => {
        this.#timers.delete(timer);
        if (reliable) this.#pendingReliable--;
        fn();
      },
      Math.max(0, at - this.now()),
    );
    this.#timers.add(timer);
    return true;
  }

  close(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    this.#pendingReliable = 0;
  }
}
