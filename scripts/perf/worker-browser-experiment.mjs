// Експеримент Lab 07 / M4: чи виграє ГОЛОВНИЙ потік браузера, якщо декодування бінарного
// снапшота винести у Web Worker? Міряємо CPU головного потоку (CDP Performance.TaskDuration)
// за 10 с при 30 снапшотах/с:
//   D) базова лінія: лише таймер + копія буфера (те, що робить сам обмін)
//   A) декодування на головному потоці (як зараз)
//   B) worker декодує і повертає записи (structured clone масиву об'єктів)
//   C) worker декодує і повертає плоский Float64Array через transfer
// node scripts/perf/worker-browser-experiment.mjs [entities=60] [secs=10]
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const N = Number(process.argv[2] ?? 60);
const SECS = Number(process.argv[3] ?? 10);
const root = path.resolve(import.meta.dirname, "../..");
const esbuild = await import("esbuild").catch(async () => {
  const { createRequire } = await import("node:module");
  return createRequire(import.meta.url)(process.env.ESBUILD_PATH ?? "esbuild");
});
let chromium;
for (const name of ["@playwright/test", "playwright"]) { try { chromium = (await import(name)).chromium; } catch {} if (chromium) break; }
if (!chromium) { const { createRequire } = await import("node:module"); chromium = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH ?? "playwright").chromium; }

const dir = mkdtempSync(path.join(tmpdir(), "wk-"));
const entry = (name, code) => { const f = path.join(dir, name); writeFileSync(f, code); return f; };
const codec = path.join(root, "shared/src/codec/index.ts");
const bundle = async (file, globalName) =>
  (await esbuild.build({ entryPoints: [file], bundle: true, write: false, format: "iife", globalName, platform: "browser" })).outputFiles[0].text;

const pageCode = await bundle(entry("page.ts", `
import { decodeBinary, encodeSnapshot } from ${JSON.stringify(codec)};
export const make = (n) => {
  const entities = Array.from({ length: n }, (_, i) => ({ id: i + 1, kind: 1 + (i % 4), flags: 0, x: i * 7.5, y: i * 3.25, vx: 1, vy: -1, angle: 0.5, a: 3, b: 0, c: i & 255 }));
  return encodeSnapshot({ type: "snapshot", tick: 1, ack: 0, entities });
};
export const decode = (buf) => decodeBinary(buf);
`), "Exp");
const workerCode = await bundle(entry("worker.ts", `
import { decodeBinary } from ${JSON.stringify(codec)};
self.onmessage = (e) => {
  const { mode, buf } = e.data;
  const msg = decodeBinary(new Uint8Array(buf));
  if (mode === "B") { self.postMessage(msg); return; }
  const ents = msg.entities, flat = new Float64Array(ents.length * 11);
  ents.forEach((r, i) => flat.set([r.id, r.kind, r.flags, r.x, r.y, r.vx, r.vy, r.angle, r.a, r.b, r.c], i * 11));
  self.postMessage(flat, [flat.buffer]);
};
`), "W");

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent("<body></body>");
await page.addScriptTag({ content: pageCode });
const cdp = await page.context().newCDPSession(page);
await cdp.send("Performance.enable");
const taskMs = async () => (await cdp.send("Performance.getMetrics")).metrics.find((m) => m.name === "TaskDuration").value * 1000;

const run = (mode) => page.evaluate(async ({ mode, N, SECS, workerCode }) => {
  const frame = Exp.make(N);
  const worker = mode === "B" || mode === "C" ? new Worker(URL.createObjectURL(new Blob([workerCode], { type: "text/javascript" }))) : null;
  let got = 0, sent = 0, sink = 0;
  if (worker) worker.onmessage = (e) => { got++; sink += e.data.entities ? e.data.entities.length : e.data.length; };
  await new Promise((r) => setTimeout(r, 300)); // прогрів
  window.__t0 = performance.now();
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      const copy = frame.slice();                       // «прийшов кадр із мережі»
      sent++;
      if (mode === "A") { sink += Exp.decode(new Uint8Array(copy.buffer ?? copy)).entities.length; got++; }
      else if (worker) worker.postMessage({ mode, buf: copy.buffer }, [copy.buffer]);
      if (sent >= SECS * 30) { clearInterval(timer); setTimeout(resolve, 200); }
    }, 1000 / 30);
  });
  worker?.terminate();
  return { sent, got, sink };
}, { mode, N, SECS, workerCode });

const results = [];
for (const mode of ["D", "A", "B", "C"]) {
  const before = await taskMs();
  const info = await run(mode);
  const used = (await taskMs()) - before;
  results.push({ mode, ...info, mainThreadMs: Math.round(used), perSnapshotUs: Math.round((used * 1000) / info.sent) });
}
await browser.close();
const base = results.find((r) => r.mode === "D").perSnapshotUs;
const label = { D: "базова лінія (таймер+копія)", A: "декодування на головному", B: "worker -> clone записів", C: "worker -> Float64Array transfer" };
console.log(`N = ${N} сутностей, ${SECS} с, 30 снап/с`);
for (const r of results) console.log(`${r.mode}) ${label[r.mode].padEnd(34)} ${String(r.perSnapshotUs).padStart(6)} мкс/снапшот на головному потоці   (за вирахуванням бази: ${r.perSnapshotUs - base} мкс)`);
