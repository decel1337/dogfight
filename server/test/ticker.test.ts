import assert from "node:assert/strict";
import { test } from "vitest";
import { Ticker } from "../src/ticker.ts";
import { sleep } from "./helpers.ts";

test("ticker: абсолютні цілі — за 1 с ≈ 30 тиків без дрейфу", async () => {
  let count = 0;
  const ticker = new Ticker({ onTick: () => count++ });
  const t0 = performance.now();
  ticker.start();
  await sleep(1000);
  ticker.stop();
  const elapsed = performance.now() - t0;
  const expected = elapsed / (1000 / 30);
  assert.ok(
    Math.abs(count - expected) <= 2,
    `${count} тиків за ${elapsed | 0} мс`,
  );
  assert.ok((ticker.stats().jitterMs?.p99 ?? Infinity) < 25);
});

test("ticker: після блокування наздоганяє, але не більше maxCatchUp", async () => {
  let count = 0;
  const ticker = new Ticker({
    tickMs: 10,
    maxCatchUp: 3,
    onTick: () => {
      count++;
      if (count === 1) {
        const end = performance.now() + 100; // 10 тиків «боргу»
        while (performance.now() < end);
      }
    },
  });
  ticker.start();
  await sleep(150);
  ticker.stop();
  assert.ok(ticker.skipped > 0, "частину боргу відкинуто");
});

test("ticker: stop зупиняє, повторний start працює", async () => {
  let count = 0;
  const ticker = new Ticker({ tickMs: 5, onTick: () => count++ });
  ticker.start();
  await sleep(30);
  ticker.stop();
  const frozen = count;
  await sleep(30);
  assert.equal(count, frozen);
  ticker.start();
  await sleep(30);
  ticker.stop();
  assert.ok(count > frozen);
});
