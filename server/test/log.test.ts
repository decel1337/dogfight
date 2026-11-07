import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";
import { MatchLogs, NdjsonTransform } from "../src/log/matchlog.ts";
import { replay } from "../src/log/replay.ts";
import { silentLogger } from "../src/logger.ts";
import { Room } from "../src/rooms.ts";
import { tempDir } from "./helpers.ts";

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

test("NdjsonTransform: одна подія = один JSON-рядок", async () => {
  const chunks: string[] = [];
  await pipeline(
    Readable.from([{ t: 1, type: "join" }, { t: 2, type: "chat", text: "a\nb" }]),
    new NdjsonTransform(),
    new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString());
        cb();
      },
    }),
  );
  const text = chunks.join("");
  const lines = text.trimEnd().split("\n");
  assert.equal(lines.length, 2, "\\n усередині тексту екранується JSON.stringify");
  assert.deepEqual(JSON.parse(lines[1] ?? ""), { t: 2, type: "chat", text: "a\nb" });
  assert.ok(text.endsWith("\n"));
});

test("MatchLogs: події кімнати потрапляють у файл до закриття", async () => {
  const dir = tempDir("matchlog-");
  const logs = new MatchLogs({ dir, log: silentLogger });
  const room = new Room({ id: "r-1", name: "R", maxPlayers: 4, arena: { width: 800, height: 600 } });

  const job = logs.start(room);
  const p = room.add("Ann");
  room.chat(p.id, "привіт");
  room.remove(p.id);
  room.close();
  await job.done;

  const lines = (await readFile(job.file, "utf8")).trimEnd().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.type), ["join", "chat", "leave"]);
  assert.equal(lines[1].text, "привіт");
  assert.match(path.basename(job.file), /^r-1-.*\.ndjson$/);
});

test("replay: розбирає NDJSON, не ламає багатобайтові символи на межі шматків", async () => {
  const dir = tempDir("replay-");
  const file = path.join(dir, "x.ndjson");
  const events = Array.from({ length: 50 }, (_, i) => ({ i, text: "привіт 🚀 світе" }));
  await writeFile(file, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);

  // highWaterMark: 3 байти розрізає і кирилицю (2 байти), і емодзі (4 байти).
  const parsed = await collect(replay(file, { highWaterMark: 3 }));
  assert.deepEqual(parsed, events);
});

test("replay: останній рядок без \\n читається; битий рядок дає помилку з номером", async () => {
  const dir = tempDir("replay-");
  const ok = path.join(dir, "ok.ndjson");
  await writeFile(ok, '{"a":1}\n{"a":2}');
  assert.deepEqual(await collect(replay(ok)), [{ a: 1 }, { a: 2 }]);

  const bad = path.join(dir, "bad.ndjson");
  await writeFile(bad, '{"a":1}\n{oops\n');
  await assert.rejects(collect(replay(bad)), /Рядок 2/);
});

test("backpressure: pipeline не накопичує дані перед повільним споживачем", async () => {
  let maxQueued = 0;
  let written = 0;
  const sink = new Writable({
    highWaterMark: 1024,
    write(chunk, _enc, cb) {
      written += chunk.length;
      maxQueued = Math.max(maxQueued, sink.writableLength);
      setImmediate(cb); // «повільний» приймач
    },
  });
  const transform = new NdjsonTransform();
  let produced = 0;
  async function* source() {
    for (let i = 0; i < 20_000; i++) {
      produced++;
      yield { i, pad: "x".repeat(100) };
    }
  }
  let maxAhead = 0;
  transform.on("data", () => {}); // не підключаємо: перевіряємо через pipeline нижче
  transform.removeAllListeners("data");

  const watcher = setInterval(() => {
    maxAhead = Math.max(maxAhead, produced * 130 - written);
  }, 1);
  await pipeline(Readable.from(source()), new NdjsonTransform(), sink);
  clearInterval(watcher);

  assert.ok(written > 2_000_000);
  // Виробник ніколи не випереджає споживача більше ніж на кілька сотень КБ,
  // хоча загалом проходить ~2.6 МБ.
  assert.ok(maxAhead < 600_000, `виробник випередив споживача на ${maxAhead} байт`);
  assert.ok(maxQueued <= 1024 + 200, `у черзі приймача було ${maxQueued} байт`);
});
