// «Prove it» для Lab 05: короткі експерименти замість тверджень.
// Запуск: node shared/scripts/prove-it.mjs
import { DT } from "../src/constants.ts";
import { hashWorld } from "../src/sim/index.ts";
import { integrate } from "../src/sim/integrate.ts";
import { runScenario } from "../test/helpers.ts";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. Порядок байтів: DataView із littleEndian=true vs без; Uint16Array
// залежить від платформи (тут — little-endian), тому для протоколу не годиться.
{
  const buf = new ArrayBuffer(2);
  const dv = new DataView(buf);
  dv.setUint16(0, 0x1234, true);
  const little = [...new Uint8Array(buf)];
  dv.setUint16(0, 0x1234, false);
  const big = [...new Uint8Array(buf)];
  new Uint16Array(buf)[0] = 0x1234;
  const typed = [...new Uint8Array(buf)];
  console.log(
    "1. endianness  LE:",
    little.map((b) => b.toString(16)),
    "BE:",
    big.map((b) => b.toString(16)),
    "Uint16Array на цій машині:",
    typed.map((b) => b.toString(16)),
  );
}

// 2. setInterval(33.3) проти абсолютних цілей: дрейф за 3 с із «шумним» циклом.
async function drift(kind) {
  const TICK = 1000 / 30;
  let count = 0;
  const start = performance.now();
  const noise = () => {
    const e = performance.now() + 2;
    while (performance.now() < e);
  };
  if (kind === "setInterval") {
    const id = setInterval(() => {
      count++;
      noise();
    }, TICK);
    await sleep(3000);
    clearInterval(id);
  } else {
    let target = start + TICK;
    let stop = false;
    const run = () => {
      while (performance.now() >= target) {
        count++;
        noise();
        target += TICK;
      }
      if (!stop) setTimeout(run, Math.max(0, target - performance.now()));
    };
    setTimeout(run, TICK);
    await sleep(3000);
    stop = true;
  }
  const elapsed = performance.now() - start;
  return { kind, ticks: count, expected: Math.round(elapsed / TICK) };
}
console.log("2. таймери (3 с, 30 Гц, +2 мс роботи на тик):");
console.table([await drift("setInterval"), await drift("absolute")]);

// 3. Детермінізм: той самий seed -> той самий хеш; Math.random у integrate ламає.
const h1 = hashWorld(runScenario(1000, 7));
const h2 = hashWorld(runScenario(1000, 7));
console.log(
  "3. hash(seed 7, 1000 тиків) двічі:",
  h1,
  h2,
  h1 === h2 ? "ЗБІГАЄТЬСЯ" : "РОЗБІЖНІСТЬ",
);
{
  // «Зламаний» integrate: Math.random() у рівнянні руху.
  const state = {
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    angle: 0,
    cooldown: 0,
    rapid: false,
  };
  const arena = { width: 1200, height: 800 };
  const run = (noisy) => {
    let s = state;
    for (let i = 0; i < 100; i++) {
      const next = integrate(s, { thrust: 1, turn: 1, fire: 0 }, DT, arena);
      s = noisy ? { ...next, x: next.x + Math.random() - 0.5 } : next;
    }
    return s.x;
  };
  console.log(
    "   чистий integrate двічі:",
    run(false) === run(false) ? "однаково" : "по-різному",
    "| з Math.random двічі:",
    run(true) === run(true) ? "однаково" : "по-різному",
  );
}
