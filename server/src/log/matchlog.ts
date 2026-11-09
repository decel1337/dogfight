import { on } from "node:events";
import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Logger } from "../logger.ts";
import type { Room } from "../rooms.ts";

// Object-mode Transform: на вході об'єкти-події, на виході рядки NDJSON
// (один JSON на рядок, `\n` як роздільник).
export class NdjsonTransform extends Transform {
  constructor() {
    super({ writableObjectMode: true, readableObjectMode: false });
  }

  override _transform(
    event: unknown,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      callback(null, `${JSON.stringify(event)}\n`);
    } catch (error: unknown) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

async function* unwrap(
  events: AsyncIterable<unknown[]>,
): AsyncGenerator<unknown> {
  // events.on() віддає масиви аргументів: [event]
  for await (const [event] of events) yield event;
}

// Кожна кімната має власний лог матчу. Події кімнати -> Transform -> файл.
// pipeline сам стежить за backpressure й закриває всі потоки при помилці.
export class MatchLogs {
  readonly dir: string;
  readonly log: Logger;
  readonly now: () => number;
  readonly #jobs = new Set<Promise<void>>();

  constructor({
    dir,
    log,
    now = Date.now,
  }: { dir: string; log: Logger; now?: () => number }) {
    this.dir = dir;
    this.log = log;
    this.now = now;
    mkdirSync(dir, { recursive: true });
  }

  start(room: Room): { id: string; file: string; done: Promise<void> } {
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
      .catch((error: unknown) => {
        this.log.error("match log failed", {
          id,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => this.#jobs.delete(job));

    this.#jobs.add(job);
    return { id, file, done: job };
  }

  // Чекаємо, поки всі файли дописані й закриті (для graceful shutdown).
  async flush(): Promise<void> {
    await Promise.allSettled([...this.#jobs]);
  }
}
