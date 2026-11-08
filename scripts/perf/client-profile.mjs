// Профіль клієнта: 30 с сесії з 8 ботами та інтенсивною стрільбою у справжньому Chromium.
// Збирає: кадри (rAF) p50/p95/p99, GC (CDP Tracing: MinorGC/MajorGC кількість і сумарна пауза),
// топ алокаторів (HeapProfiler sampling), топ функцій за self-time (Profiler), User Timing.
// Запуск: node scripts/perf/client-profile.mjs --static client/dist --label before [--secs 30] [--bots 8]
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const LABEL = arg("label", "run");
const SECS = Number(arg("secs", "30"));
const BOTS = Number(arg("bots", "8"));
// --profilers 0: лише кадри + GC (трасування). CPU-/heap-профайлери самі збурюють GC, тому
// чисті цифри кадрів/GC беремо з прогону БЕЗ них, а алокатори й self-time — з прогону З ними.
const PROFILERS = arg("profilers", "1") !== "0";
// Чистий прогін (--profilers 0) іде і без User Timing (?perf=1): measure-записи теж створюють сміття.
const PERF = PROFILERS;
const STATIC = path.resolve(arg("static", "client/dist"));
const PORT = Number(arg("port", "3931"));
const OUT = path.resolve(arg("out", "perf"));
mkdirSync(OUT, { recursive: true });

let chromium;
for (const name of ["@playwright/test", "playwright"]) {
  try { chromium = (await import(name)).chromium; } catch { /* пробуємо наступний пакет */ }
  if (chromium) break;
}
if (!chromium) { // sandbox: глобальний playwright
  const { createRequire } = await import("node:module");
  chromium = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH ?? "playwright").chromium;
}

const root = path.resolve(import.meta.dirname, "../..");
const server = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", `${root}/server/src/index.ts`], {
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", STATIC_DIR: STATIC, LOG_DIR: mkdtempSync(path.join(tmpdir(), "cp-")) },
  stdio: "ignore",
});
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
const json = async (url, method, body) => (await fetch(base + url, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) })).json();
const room = await json("/api/rooms", "POST", { name: `perf-${LABEL}`, maxPlayers: 8 });
await json(`/api/rooms/${room.id}/bots`, "POST", { count: BOTS });

const browser = await chromium.launch({ args: ["--enable-precise-memory-info", `--js-flags=--expose-gc ${arg("jsflags", "")}`] });
const page = await (await browser.newContext({ viewport: { width: 1000, height: 700 } })).newPage();
await page.addInitScript(() => {
  // rAF-дельти без алокацій у гарячому шляху: фіксований Float64Array.
  const frames = new Float64Array(60 * 120);
  let n = 0, last = 0;
  window.__frames = () => Array.from(frames.subarray(0, n));
  const tick = (t) => { if (last && n < frames.length && window.__recording) frames[n++] = t - last; last = t; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  // Тривалості measure — у попередньо виділених Float64Array; буфер записів чистимо щосекунди,
  // щоб самі PerformanceMeasure не накопичувались і не спотворювали GC.
  const store = {};
  const counts = {};
  window.__measures = () => Object.fromEntries(Object.keys(store).map((k) => [k, Array.from(store[k].subarray(0, counts[k]))]));
  window.__resetMeasures = () => { for (const k of Object.keys(counts)) counts[k] = 0; };
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      const arr = (store[e.name] ??= new Float64Array(60 * 120));
      const n = (counts[e.name] ??= 0);
      if (window.__recording && n < arr.length) { arr[n] = e.duration; counts[e.name] = n + 1; }
    }
  }).observe({ entryTypes: ["measure"] });
  setInterval(() => performance.clearMeasures(), 1000);
});
await page.goto(`${base}/${PERF ? "?perf=1" : ""}`);
await page.mouse.click(500, 350);
await page.getByLabel("Pilot call:").fill("Perf");
const row = page.locator("div", { hasText: room.name }).filter({ has: page.getByRole("button", { name: "JOIN" }) }).last();
await row.getByRole("button", { name: "JOIN" }).click({ timeout: 10_000 });
await page.waitForFunction(() => window.__dogfight?.game?.ready === true, undefined, { timeout: 10_000 });
await page.waitForTimeout(3000); // прогрів
await page.evaluate(() => { window.__resetMeasures(); window.__recording = true; });

const cdp = await page.context().newCDPSession(page);
if (PROFILERS) await cdp.send("HeapProfiler.enable");
if (PROFILERS) await cdp.send("HeapProfiler.startSampling", { samplingInterval: 2048, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
if (PROFILERS) {
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await cdp.send("Profiler.start");
}
const events = [];
cdp.on("Tracing.dataCollected", (d) => events.push(...d.value));
const tracingDone = new Promise((r) => cdp.once("Tracing.tracingComplete", r));
await cdp.send("Tracing.start", { traceConfig: { includedCategories: ["v8", "devtools.timeline", "disabled-by-default-v8.gc"] }, transferMode: "ReportEvents" });

// «Heavy shooting»: тримаємо Space і крутимось/летимо — клієнт стріляє щотику.
if (arg("keys", "1") !== "0") {
  await page.keyboard.down("Space");
  await page.keyboard.down("ArrowUp");
  await page.keyboard.down("ArrowRight");
}
await page.waitForTimeout(SECS * 1000);
await page.keyboard.up("Space"); await page.keyboard.up("ArrowUp"); await page.keyboard.up("ArrowRight");

const empty = { nodes: [], samples: [], timeDeltas: [] };
const cpu = PROFILERS ? (await cdp.send("Profiler.stop")).profile : empty;
const heap = PROFILERS ? (await cdp.send("HeapProfiler.stopSampling")).profile : { head: { callFrame: { functionName: "", url: "", lineNumber: 0 }, selfSize: 0, children: [] } };
await cdp.send("Tracing.end");
await tracingDone;
const frames = await page.evaluate(() => { window.__recording = false; return window.__frames(); });
const measures = await page.evaluate(() => window.__measures());
const entities = await page.evaluate(() => window.__dogfight.game.scene(1).entities.length);
await page.screenshot({ path: `${OUT}/client-${LABEL}.png` });
await browser.close();
await json(`/api/rooms/${room.id}/bots`, "DELETE");
server.kill("SIGTERM");
const killTimer = setTimeout(() => server.kill("SIGKILL"), 3000);
await new Promise((r) => server.once("exit", r)); // не залишаємо сервер на порту до наступного запуску
clearTimeout(killTimer);

const q = (xs, p) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0; };
const r = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
const stat = (xs) => ({ n: xs.length, p50: r(q(xs, 0.5)), p95: r(q(xs, 0.95)), p99: r(q(xs, 0.99)), max: r(Math.max(0, ...xs)) });

// GC із трасування: MinorGC (scavenge) і MajorGC (mark-compact); dur у мкс.
const gc = { minor: { count: 0, totalMs: 0, maxMs: 0 }, major: { count: 0, totalMs: 0, maxMs: 0 } };
const gcTimeline = [];
if (process.env.DUMP_GC) writeFileSync(`${OUT}/trace-${LABEL}.json`, JSON.stringify(events.filter((e) => /GC|gc/.test(e.name))));
const t0us = Math.min(...events.filter((e) => e.ts).map((e) => e.ts));
for (const e of events) {
  const kind = e.name === "MinorGC" ? "minor" : e.name === "MajorGC" ? "major" : null;
  if (!kind || e.ph !== "X") continue;
  const ms = e.dur / 1000;
  gcTimeline.push({ tSec: r((e.ts - t0us) / 1e6, 1), kind, ms: r(ms), heapBeforeMb: r((e.args?.usedHeapSizeBefore ?? 0) / 1048576, 1), heapAfterMb: r((e.args?.usedHeapSizeAfter ?? 0) / 1048576, 1) });
  gc[kind].count++; gc[kind].totalMs += ms; gc[kind].maxMs = Math.max(gc[kind].maxMs, ms);
}
for (const k of ["minor", "major"]) { gc[k].totalMs = r(gc[k].totalMs); gc[k].maxMs = r(gc[k].maxMs); }

// Алокатори: sampling heap profile -> сума selfSize за функцією.
const alloc = new Map();
(function walk(n) {
  const f = n.callFrame;
  const key = `${f.functionName || "(anon)"} ${f.url.split("/").slice(-1)[0]}:${f.lineNumber + 1}`;
  if (n.selfSize) alloc.set(key, (alloc.get(key) ?? 0) + n.selfSize);
  n.children.forEach(walk);
})(heap.head);
const totalAlloc = [...alloc.values()].reduce((a, b) => a + b, 0) || 1;
const topAlloc = [...alloc].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([fn, bytes]) => ({ fn, kb: Math.round(bytes / 1024), pct: r((bytes / totalAlloc) * 100, 1) }));

// Self-time із CPU-профілю.
const byId = new Map(cpu.nodes.map((n) => [n.id, n]));
const self = new Map();
cpu.samples.forEach((id, i) => {
  const f = byId.get(id).callFrame;
  const key = `${f.functionName || "(anon)"} ${f.url.split("/").slice(-1)[0]}:${f.lineNumber + 1}`;
  self.set(key, (self.get(key) ?? 0) + (cpu.timeDeltas[i] ?? 0));
});
const totalCpu = [...self.values()].reduce((a, b) => a + b, 0) || 1;
const topSelf = [...self].filter(([k]) => !k.startsWith("(idle)")).sort((a, b) => b[1] - a[1]).slice(0, 10)
  .map(([fn, us]) => ({ fn, ms: r(us / 1000, 0), pct: r((us / totalCpu) * 100, 1) }));

const result = {
  label: LABEL, secs: SECS, bots: BOTS, entitiesInScene: entities, frames: frames.length,
  frameMs: stat(frames), gc, gcTimeline,
  measures: Object.fromEntries(Object.entries(measures).map(([k, v]) => [k, stat(v)])),
  allocatedKbTotal: Math.round(totalAlloc / 1024), topAlloc, topSelf,
};
const tag = PROFILERS ? LABEL : `${LABEL}-clean`;
writeFileSync(`${OUT}/client-${tag}.json`, JSON.stringify(result, null, 2));
if (PROFILERS) writeFileSync(`${OUT}/client-${LABEL}.cpuprofile`, JSON.stringify(cpu));
console.log(JSON.stringify(result, null, 2));
