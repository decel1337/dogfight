import { afterEach, describe, expect, test, vi } from "vitest";
import { createAccumulator, createLoop } from "../src/loop.ts";

describe("createAccumulator", () => {
  test("кадр у 50 мс при кроці 1/60 дає 3 кроки й залишок", () => {
    const acc = createAccumulator({ step: 1 / 60 });
    let steps = 0;
    const result = acc.push(0.05, () => steps++);
    expect(steps).toBe(3);
    expect(result.steps).toBe(3);
    expect(result.alpha).toBeCloseTo((0.05 - 3 / 60) / (1 / 60), 6);
  });

  test("залишок часу переноситься на наступний кадр", () => {
    const acc = createAccumulator({ step: 0.1 });
    expect(acc.push(0.06, () => {}).steps).toBe(0);
    expect(acc.push(0.06, () => {}).steps).toBe(1);
  });

  test("«спіраль смерті»: довгий кадр обрізається maxFrame", () => {
    const acc = createAccumulator({ step: 1 / 60, maxFrame: 0.25 });
    let steps = 0;
    acc.push(10, () => steps++);
    expect(steps).toBe(15); // 0.25 с / (1/60), а не 600 кроків
  });
});

describe("createLoop з підміненим requestAnimationFrame", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function fakeRaf() {
    const queue = new Map<number, (time: number) => void>();
    let id = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: (time: number) => void) => {
      queue.set(++id, cb);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
      queue.delete(handle);
    });
    return {
      pending: () => queue.size,
      // Виконує один кадр на віртуальному часі `time` (мс).
      frame(time: number) {
        const [handle, cb] = [...queue.entries()][0] ?? [];
        if (handle === undefined || !cb) throw new Error("немає запланованого кадру");
        queue.delete(handle);
        cb(time);
      },
    };
  }

  test("кожен кадр викликає render, а simulate — потрібну кількість кроків", () => {
    const raf = fakeRaf();
    let simulated = 0;
    let rendered = 0;
    const loop = createLoop({ step: 1 / 60, simulate: () => simulated++, render: () => rendered++ });
    loop.start();
    raf.frame(0);
    raf.frame(1000 / 60);
    raf.frame(2000 / 60);
    expect(rendered).toBe(3);
    expect(simulated).toBe(2); // перший кадр лише ініціалізує годинник
  });

  test("метрики: після півсекунди рахуються fps і кроки/с", () => {
    const raf = fakeRaf();
    const loop = createLoop({ step: 1 / 60, simulate: () => {}, render: () => {} });
    loop.start();
    for (let t = 0; t <= 600; t += 1000 / 60) raf.frame(t);
    expect(loop.metrics.fps).toBeGreaterThan(50);
    expect(loop.metrics.fps).toBeLessThan(70);
    expect(loop.metrics.stepsPerSecond).toBeGreaterThan(50);
  });

  test("stop скасовує запланований кадр, повторний start не дублює цикл", () => {
    const raf = fakeRaf();
    const loop = createLoop({ simulate: () => {}, render: () => {} });
    loop.start();
    loop.start();
    expect(raf.pending()).toBe(1);
    loop.stop();
    expect(raf.pending()).toBe(0);
  });
});
