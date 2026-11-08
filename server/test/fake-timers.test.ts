import { afterEach, describe, expect, test, vi } from "vitest";
import { Ticker } from "../src/ticker.ts";
import { connect, createRoom, sleep, withApp } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
});

// Усі тести тут керують часом вручну: жодного реального очікування,
// тож вони швидкі й не залежать від навантаження машини.
describe("Ticker на фейкових таймерах", () => {
  test("за 1 с віртуального часу рівно 30 тиків, без дрейфу", () => {
    vi.useFakeTimers();
    let ticks = 0;
    const ticker = new Ticker({ onTick: () => ticks++, now: () => Date.now() });
    ticker.start();
    for (let ms = 0; ms < 1000; ms += 10) vi.advanceTimersByTime(10);
    ticker.stop();
    expect(ticks).toBeGreaterThanOrEqual(29);
    expect(ticks).toBeLessThanOrEqual(31);
  });

  test("зупинений тикер більше не тикає", () => {
    vi.useFakeTimers();
    let ticks = 0;
    const ticker = new Ticker({ onTick: () => ticks++, now: () => Date.now() });
    ticker.start();
    vi.advanceTimersByTime(100);
    ticker.stop();
    const frozen = ticks;
    vi.advanceTimersByTime(1000);
    expect(ticks).toBe(frozen);
    expect(ticker.running).toBe(false);
  });

  test("після «зависання» наздоганяє не більше maxCatchUp, решту боргу відкидає", () => {
    vi.useFakeTimers();
    let clock = 0;
    let ticks = 0;
    const ticker = new Ticker({ tickMs: 10, maxCatchUp: 3, onTick: () => ticks++, now: () => clock });
    ticker.start();
    clock = 500; // процес «завис» на 500 мс = 50 тиків боргу
    vi.advanceTimersByTime(10);
    expect(ticks).toBe(3);
    expect(ticker.skipped).toBeGreaterThan(40);
  });
});

describe("heartbeat на фейкових таймерах", () => {
  test("мертвий клієнт розривається після MAX_MISSED_PONGS інтервалів, живий — ні", async () => {
    // Фейкуємо лише інтервали: мережевий ввід-вивід лишається справжнім.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    await withApp({ HEARTBEAT_MS: "15000", MAX_MISSED_PONGS: "2" }, async (ctx) => {
      const room = await createRoom(ctx);
      const alive = connect(ctx.wsUrl);
      const dead = connect(ctx.wsUrl, { autoPong: false });
      await Promise.all([alive.opened, dead.opened]);
      alive.send({ type: "join", room: room.id, name: "Alive" });
      dead.send({ type: "join", room: room.id, name: "Dead" });
      await alive.next("joined");
      await dead.next("joined");

      // Інтервал 1: ping надіслано. Інтервал 2: пропущено 1 (< 2). Інтервал 3: 2 -> terminate.
      for (let interval = 1; interval <= 3; interval++) {
        vi.advanceTimersByTime(15_000);
        await sleep(40); // даємо живому клієнтові справжній час відповісти pong
      }
      const closed = await dead.closed;
      expect(closed.code).toBe(1006);
      expect(alive.ws.readyState).toBe(alive.ws.OPEN);
    });
  });
});
