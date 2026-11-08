// Експеримент: винести encodeSnapshot у Worker. Міряємо ЧАС ГОЛОВНОГО ПОТОКУ на тик
// (він і є вузьким місцем) для трьох варіантів + затримку відповіді.
//   A) кодуємо на місці
//   B) postMessage(records[]) -> worker кодує -> transfer ArrayBuffer назад
//   C) те саме, але записи вже лежать у плоскому Float64Array (SoA) і передаються transfer-ом
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { encodeSnapshot } from "@dogfight/shared/codec";

const N = Number(process.argv[2] ?? 300); // сутностей у снапшоті (≈ 128 кораблів + кулі)
const TICKS = 1500;
const mkRecords = () => Array.from({ length: N }, (_, i) => ({
  id: i + 1, kind: 1 + (i % 4), flags: i & 7, x: i * 1.5, y: i * 2.5, vx: 1, vy: -1, angle: 0.5, a: 3, b: 0, c: i & 255,
}));

if (!isMainThread) {
  parentPort.on("message", (m) => {
    let entities = m.entities;
    if (m.flat) {
      const f = m.flat; entities = [];
      for (let i = 0; i < f.length; i += 11) entities.push({ id: f[i], kind: f[i + 1], flags: f[i + 2], x: f[i + 3], y: f[i + 4], vx: f[i + 5], vy: f[i + 6], angle: f[i + 7], a: f[i + 8], b: f[i + 9], c: f[i + 10] });
    }
    const out = encodeSnapshot({ type: "snapshot", tick: m.tick, ack: 0, entities });
    parentPort.postMessage(out.buffer, [out.buffer]);
  });
} else {
  const records = mkRecords();
  const q = (xs, p) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length * p)];
  const report = (name, main, latency) =>
    console.log(`${name.padEnd(34)} main avg ${(main.reduce((a, b) => a + b) / main.length * 1000).toFixed(1).padStart(7)} µs  p99 ${(q(main, 0.99) * 1000).toFixed(1).padStart(7)} µs` + (latency ? `   round-trip p50 ${q(latency, 0.5).toFixed(3)} ms` : ""));

  const timeA = [];
  for (let t = 0; t < TICKS; t++) { const s = performance.now(); encodeSnapshot({ type: "snapshot", tick: t, ack: 0, entities: records }); timeA.push(performance.now() - s); }
  report("A) encode на головному потоці", timeA.slice(200));

  const worker = new Worker(new URL(import.meta.url), { execArgv: process.execArgv });
  const roundTrip = (post) => new Promise((resolve) => {
    const times = [], lat = [];
    let t = 0;
    const send = () => {
      const s = performance.now(); post(t); times.push(performance.now() - s); lat.push(s);
    };
    worker.on("message", () => {
      lat[t] = performance.now() - lat[t];
      if (++t < TICKS) send(); else { worker.removeAllListeners("message"); resolve([times.slice(200), lat.slice(200)]); }
    });
    send();
  });
  const [timeB, latB] = await roundTrip((t) => worker.postMessage({ tick: t, entities: records }));
  report("B) postMessage(records[]) (clone)", timeB, latB);

  const flat = new Float64Array(N * 11);
  records.forEach((e, i) => flat.set([e.id, e.kind, e.flags, e.x, e.y, e.vx, e.vy, e.angle, e.a, e.b, e.c], i * 11));
  let buf = flat;
  const [timeC, latC] = await roundTrip((t) => {
    const copy = buf.slice(); // у справжній системі SoA-буфер переписується щотику
    worker.postMessage({ tick: t, flat: copy }, [copy.buffer]);
  });
  report("C) SoA Float64Array + transfer", timeC, latC);
  await worker.terminate();
}
