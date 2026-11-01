// Генератор синтетичного NDJSON-логу потрібного розміру.
// Сам пише потоком (Readable.from + pipeline), тому генерація 200 МБ
// не тримає в пам'яті більше за кілька шматків.
//
//   node scripts/gen-log.mjs <файл> [МБ=200]
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

export async function generateLog(file, megabytes = 200) {
  const target = megabytes * 1024 * 1024;

  async function* lines() {
    let written = 0;
    let n = 0;
    const t0 = 1_700_000_000_000;
    while (written < target) {
      const line = `${JSON.stringify({
        t: t0 + n * 16,
        type: "chat",
        from: (n % 8) + 1,
        text: `синтетична подія ${n} `.repeat(4),
      })}\n`;
      written += Buffer.byteLength(line);
      n++;
      yield line;
    }
  }

  await pipeline(Readable.from(lines()), createWriteStream(file));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file, mb] = process.argv.slice(2);
  if (!file) {
    console.error("використання: node scripts/gen-log.mjs <файл> [МБ]");
    process.exit(2);
  }
  await generateLog(file, mb ? Number(mb) : 200);
  console.log(`готово: ${file}`);
}
