// Token bucket: у відрі до `burst` токенів, поповнення `ratePerSec` за секунду.
// Кожне повідомлення коштує один токен. Годинник можна підмінити в тестах.
export class TokenBucket {
  readonly ratePerSec: number;
  readonly burst: number;
  readonly now: () => number;
  #tokens: number;
  #last: number;

  constructor({
    ratePerSec,
    burst,
    now = () => performance.now(),
  }: {
    ratePerSec: number;
    burst: number;
    now?: () => number;
  }) {
    this.ratePerSec = ratePerSec;
    this.burst = burst;
    this.now = now;
    this.#tokens = burst;
    this.#last = now();
  }

  take(cost = 1): boolean {
    const t = this.now();
    const elapsed = Math.max(0, t - this.#last) / 1000;
    this.#last = t;
    this.#tokens = Math.min(
      this.burst,
      this.#tokens + elapsed * this.ratePerSec,
    );
    if (this.#tokens < cost) return false;
    this.#tokens -= cost;
    return true;
  }
}
