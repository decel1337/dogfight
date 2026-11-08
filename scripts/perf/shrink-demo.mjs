// Демонстрація shrinking: навмисно зламаний кодек кута (int16 без обмеження) — fast-check
// знаходить і СТИСКАЄ контрприклад до мінімального. Потрібен встановлений fast-check.
// node scripts/perf/shrink-demo.mjs
import fc from "fast-check";
const ANGLE_SCALE = 10_000;
const encodeAngleBuggy = (a) => { const v = new DataView(new ArrayBuffer(2)); v.setInt16(0, Math.round(a * ANGLE_SCALE), true); return v; }; // переповнення int16 при |a| > 3.2767
const decodeAngle = (v) => v.getInt16(0, true) / ANGLE_SCALE;
try {
  fc.assert(fc.property(fc.double({ min: -10, max: 10, noNaN: true }), (a) => Math.abs(decodeAngle(encodeAngleBuggy(a)) - a) < 1e-3), { seed: 7 });
  console.log("контрприкладу не знайдено (несподівано)");
} catch (e) {
  console.log(String(e.message).split("\n").slice(0, 6).join("\n")); // «Counterexample: [3.2768…]», «Shrunk N time(s)»
}
