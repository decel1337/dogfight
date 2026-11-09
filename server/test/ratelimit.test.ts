import assert from "node:assert/strict";
import { test } from "vitest";
import { TokenBucket } from "../src/ratelimit.ts";

test("token bucket: дозволяє burst, потім відмовляє", () => {
  const now = 0;
  const bucket = new TokenBucket({ ratePerSec: 5, burst: 3, now: () => now });
  assert.deepEqual(
    [bucket.take(), bucket.take(), bucket.take(), bucket.take()],
    [true, true, true, false],
  );
});

test("token bucket: поповнюється з часом, але не вище burst", () => {
  let now = 0;
  const bucket = new TokenBucket({ ratePerSec: 10, burst: 3, now: () => now });
  for (let i = 0; i < 3; i++) bucket.take();
  assert.equal(bucket.take(), false);

  now += 100; // +1 токен
  assert.equal(bucket.take(), true);
  assert.equal(bucket.take(), false);

  now += 60_000; // довга пауза не накопичує більше burst
  const results = Array.from({ length: 5 }, () => bucket.take());
  assert.deepEqual(results, [true, true, true, false, false]);
});

test("token bucket: токени ніколи не йдуть у мінус, час назад не ламає", () => {
  let now = 1000;
  const bucket = new TokenBucket({ ratePerSec: 1, burst: 1, now: () => now });
  assert.equal(bucket.take(), true);
  now = 500; // годинник «стрибнув» назад
  assert.equal(bucket.take(), false);
  now = 2500;
  assert.equal(bucket.take(), true);
});
