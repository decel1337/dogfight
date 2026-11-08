// Prove-it Lab 07: 1) deopt/inline caches, 2) object[] vs Float32Array (SoA), 3) clone vs transfer.
// node --allow-natives-syntax scripts/perf/prove-it-7.mjs
const time = (fn, reps = 5) => { const xs = []; for (let i = 0; i < reps; i++) { const s = performance.now(); fn(); xs.push(performance.now() - s); } return xs.sort((a, b) => a - b)[reps >> 1]; };

// --- 1. Мономорфний vs мегаморфний доступ до полів (hidden classes) ---
{
  const N = 2_000_000;
  const mono = Array.from({ length: 64 }, (_, i) => ({ x: i, y: i * 2, vx: 1, vy: 1 }));
  // 6 різних «форм» (різний порядок/набір полів) -> inline cache стає мегаморфним (>4 форм)
  const shapes = [
    (i) => ({ x: i, y: i, vx: 1, vy: 1 }), (i) => ({ y: i, x: i, vx: 1, vy: 1 }),
    (i) => ({ x: i, y: i, vy: 1, vx: 1 }), (i) => ({ x: i, y: i, vx: 1, vy: 1, a: 0 }),
    (i) => ({ x: i, y: i, vx: 1, vy: 1, b: 0 }), (i) => ({ a: 0, x: i, y: i, vx: 1, vy: 1 }),
  ];
  const mega = Array.from({ length: 66 }, (_, i) => shapes[i % 6](i));
  // Дві НЕЗАЛЕЖНІ функції (власний feedback-вектор): інакше мегаморфні форми «забруднили» б і мономорфну.
  const src = "(arr) => { let s = 0; for (let k = 0; k < " + N + " / arr.length; k++) for (let i = 0; i < arr.length; i++) { const e = arr[i]; s += e.x + e.y + e.vx + e.vy; } return s; }";
  const sumMono = (0, eval)(src), sum = (0, eval)(src);
  sumMono(mono); sum(mega); // прогрів кожної на своїх даних
  const tMono = time(() => sumMono(mono)); const tMega = time(() => sum(mega));
  console.log(`1) мономорфно ${tMono.toFixed(1)} мс  vs мегаморфно (6 форм) ${tMega.toFixed(1)} мс  → ×${(tMega / tMono).toFixed(1)}`);
  try { // %-natives доступні лише з --allow-natives-syntax; у файлі їх не можна писати напряму
    const status = new Function("f", "return %GetOptimizationStatus(f)");
    console.log("   біти статусу sum (бачимо, що функція оптимізована TurboFan):", status(sum).toString(2));
  } catch { console.log("   (запустіть з --allow-natives-syntax, щоб побачити статус оптимізації)"); }
}

// --- 2. Масив об'єктів vs Float32Array (SoA) ---
{
  const N = 100_000, STEPS = 200;
  const objs = Array.from({ length: N }, (_, i) => ({ x: i, y: i, vx: 1, vy: -1 }));
  const xs = new Float32Array(N).map((_, i) => i), ys = new Float32Array(N).map((_, i) => i);
  const vx = new Float32Array(N).fill(1), vy = new Float32Array(N).fill(-1);
  const tObj = time(() => { for (let s = 0; s < STEPS; s++) for (let i = 0; i < N; i++) { const o = objs[i]; o.x += o.vx * 0.033; o.y += o.vy * 0.033; } });
  const tSoA = time(() => { for (let s = 0; s < STEPS; s++) for (let i = 0; i < N; i++) { xs[i] += vx[i] * 0.033; ys[i] += vy[i] * 0.033; } });
  console.log(`2) об'єкти ${tObj.toFixed(1)} мс  vs Float32Array SoA ${tSoA.toFixed(1)} мс  → ×${(tObj / tSoA).toFixed(1)} (пам'ять: ${(N * (16 + 8 * 4) / 1e6).toFixed(1)} МБ vs ${(N * 16 / 1e6).toFixed(1)} МБ)`);
}

// --- 3. structuredClone vs transfer 50 МБ ---
{
  const mb50 = () => new Uint8Array(50 * 1024 * 1024).fill(7);
  const a = mb50(); const t0 = performance.now(); const clone = structuredClone(a); const tClone = performance.now() - t0;
  const b = mb50(); const t1 = performance.now(); const moved = structuredClone(b, { transfer: [b.buffer] }); const tMove = performance.now() - t1;
  console.log(`3) clone 50 МБ ${tClone.toFixed(2)} мс  vs transfer ${tMove.toFixed(3)} мс; після transfer оригінал: byteLength=${b.byteLength} (detached), копія=${moved.byteLength}`);
  void clone;
}
