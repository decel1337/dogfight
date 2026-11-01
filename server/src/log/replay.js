import { createReadStream } from "node:fs";

// Async-генератор: файл NDJSON -> розібрані події. Файл читається потоком
// шматками, у пам'яті одночасно лише поточний шматок і неповний рядок.
// encoding: "utf8" вмикає StringDecoder, тож багатобайтові символи, розрізані
// межею шматків, не ламаються.
export async function* replay(file, { highWaterMark } = {}) {
  const stream = createReadStream(file, { encoding: "utf8", highWaterMark });
  let rest = "";
  let lineNo = 0;

  for await (const chunk of stream) {
    rest += chunk;
    let newline = rest.indexOf("\n");
    while (newline !== -1) {
      const line = rest.slice(0, newline);
      rest = rest.slice(newline + 1);
      lineNo++;
      if (line.length > 0) yield parseLine(line, lineNo);
      newline = rest.indexOf("\n");
    }
  }
  if (rest.length > 0) yield parseLine(rest, lineNo + 1);
}

function parseLine(line, lineNo) {
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(`Рядок ${lineNo}: некоректний JSON`, { cause: error });
  }
}
