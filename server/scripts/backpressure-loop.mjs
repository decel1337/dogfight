// Prove-it №3 (Lab 04): нескінченний генератор 64 КБ-буферів -> повільний
// Writable (100 мс на шматок). Порівнюємо pipeline і цикл, що ігнорує
// результат write(). Обидва варіанти зупиняємо через 3 секунди.
//
//   node scripts/backpressure-loop.mjs
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";

const CHUNK = 64 * 1024;
const MB = 1024 * 1024;
const RUN_MS = 3000;
const rss = () => process.memoryUsage().rss / MB;

const slowSink = () =>
  new Writable({
    write(_chunk, _enc, done) {
      setTimeout(done, 100);
    },
  });

async function* chunks(limit = Infinity) {
  for (let i = 0; i < limit; i++) yield Buffer.alloc(CHUNK, 1);
}

async function withPipeline() {
  const sink = slowSink();
  const source = Readable.from(chunks());
  const done = pipeline(source, sink).catch(() => {});
  await sleep(RUN_MS);
  const buffered = sink.writableLength / MB;
  source.destroy();
  sink.destroy();
  await done;
  return buffered;
}

async function ignoringWrite() {
  const sink = slowSink();
  let count = 0;
  const deadline = performance.now() + RUN_MS;
  // Ігнорує write() === false: виробник не чекає на "drain".
  // Обмежуємо 3000 шматків (~190 МБ), щоб демо не поклало машину.
  for await (const chunk of chunks(3000)) {
    sink.write(chunk);
    count++;
    if (performance.now() > deadline) break;
  }
  await sleep(RUN_MS);
  const buffered = sink.writableLength / MB;
  sink.destroy();
  return { buffered, count };
}

const base = rss();
const a = await withPipeline();
console.log(
  `pipeline:          у буфері Writable ${a.toFixed(2)} МБ, rss +${(rss() - base).toFixed(0)} МБ`,
);

global.gc?.();
const base2 = rss();
const b = await ignoringWrite();
console.log(
  `ігнор write():     у буфері Writable ${b.buffered.toFixed(0)} МБ (${b.count} шматків), rss +${(rss() - base2).toFixed(0)} МБ`,
);
