import fc from "fast-check";
import { expect, test } from "vitest";
import { TokenBucket } from "../src/ratelimit.ts";

// Властивість: за будь-якої послідовності запитів кількість дозволених
// ніколи не перевищує burst + rate × (сумарний час), тобто ліміт не обійти.
test("token bucket: дозволених запитів ≤ burst + rate·час за довільного розкладу", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 50 }),
      fc.integer({ min: 1, max: 20 }),
      fc.array(fc.integer({ min: 0, max: 400 }), { minLength: 1, maxLength: 200 }),
      (rate, burst, gaps) => {
        let now = 0;
        const bucket = new TokenBucket({ ratePerSec: rate, burst, now: () => now });
        let allowed = 0;
        for (const gap of gaps) {
          now += gap;
          if (bucket.take()) allowed++;
        }
        expect(allowed).toBeLessThanOrEqual(burst + (rate * now) / 1000 + 1e-9);
      },
    ),
  );
});
