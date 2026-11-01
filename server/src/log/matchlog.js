import { createWriteStream, mkdirSync } from "node:fs";
import { on } from "node:events";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

// Object-mode Transform: на вході об'єкти-події, на виході рядки NDJSON
// (один JSON на рядок, `\n` як роздільник).
export class NdjsonTransform extends Transform {
  constructor() {
    super({ writableObjectMode: true, readableObjectMode: false });
  }

  _transform(event, _encoding, callback) {
    try {
      callback(null, `${JSON.stringify(event)}\n`);
    } catch (error) {
      callback(error);
    }
  }
}

async function* unwrap(events) {
  // events.on() віддає масиви аргументів: [event]
  for await (const [event] of events) yield event;
}

// Кожна кімната має власний лог матчу. Події кімнати -> Transform -> файл.
// pipeline сам стежить за backpressure й закриває всі потоки при помилці.
export class MatchLogs {
  #jobs = new Set();

  constructor({ dir, log, now = Date.now }) {
    this.dir = dir;
    this.log = log;
    this.now = now;
    mkdirSync(dir, { recursive: true });
  }

  start(room) {
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, "-");
    const id = `${room.id}-${stamp}`;
    const file = path.join(this.dir, `${id}.ndjson`);

    // Підписка відбувається синхронно (до першої події кімнати), а
    // ітерація завершується, коли кімната емітить "closed".
    const events = on(room, "event", { close: ["closed"] });

    const job = pipeline(
      Readable.from(unwrap(events)),
      new NdjsonTransform(),
      createWriteStream(file, { flags: "wx" }),
    )
      .catch((error) => {
        this.log.error("match log failed", { id, error: error.message });
      })
      .finally(() => this.#jobs.delete(job));

    this.#jobs.add(job);
    return { id, file, done: job };
  }

  // Чекаємо, поки всі файли дописані й закриті (для graceful shutdown).
  async flush() {
    await Promise.allSettled([...this.#jobs]);
  }
}
