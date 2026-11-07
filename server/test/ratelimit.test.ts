import assert from "node:assert/strict";
import test from "node:test";
import { TokenBucket } from "../src/ratelimit.ts";

test("token bucket: дозволяє burst, потім відмовляє", () => {
  let now = 0;
  const bucket = new TokenBucket({ ratePerSec: 5, burst: 3, now: () => now });
  assert.deepEqual([bucket.take(), bucket.take(), bucket.take(), bucket.take()], [
    true,
    true,
    true,
    false,
  ]);
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
