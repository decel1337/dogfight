// Галерея збоїв + порівняння sequential/concurrent на справжньому HTTP-сервері.
// Запуск: node scripts/failure-gallery.mjs
import { createServer } from "node:http";
import { fetchBytes, loadAll, requestJson } from "../src/assets/loader.js";

const log = [];
const server = createServer((req, res) => {
  log.push(req.url);
  const json = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(body);
  };
  const [, kind, arg] = req.url.split("/");
  if (kind === "missing") return json(404, "{}");
  if (kind === "corrupt") return json(200, '{"rooms": [');
  if (kind === "hang") {
    return; // ніколи не відповідає
  }
  if (kind === "slow") return setTimeout(() => json(200, "{}"), Number(arg));
  if (kind === "manifest") {
    const delays = (arg ?? "").split(",").map(Number);
    const images = {};
    delays.forEach((ms, i) => {
      images[`asset${i}`] = `${base}/slow/${ms}`;
    });
    return json(200, JSON.stringify({ images }));
  }
  json(200, "{}");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const loaders = {
  image: async (url, opts) => (await fetchBytes(url, opts), url),
  sound: async () => null,
};
const describe = (e) =>
  `${e.name}${e.status ? ` ${e.status}` : ""}: ${e.message.split("(")[0].trim()}`;

console.log("=== Галерея збоїв ===");

// 1. 404
log.length = 0;
try {
  await requestJson(`${base}/missing`, { baseMs: 20 });
} catch (e) {
  console.log(`1) 404          -> ${describe(e)}; запитів: ${log.length} (без повторів)`);
}

// 2. Таймаут
log.length = 0;
const t0 = performance.now();
try {
  await requestJson(`${base}/hang`, { timeoutMs: 300, retries: 1, baseMs: 50 });
} catch (e) {
  console.log(
    `2) timeout      -> ${e.name}; запитів: ${log.length}; ${Math.round(performance.now() - t0)} мс`,
  );
}

// 3. Скасування посеред завантаження
const manifest = `${base}/manifest/3000,3000,3000`;
const controller = new AbortController();
let progress = 0;
setTimeout(() => controller.abort(), 200);
const t1 = performance.now();
try {
  await loadAll(manifest, {
    loaders,
    signal: controller.signal,
    onProgress: (done) => {
      progress = done;
    },
  });
} catch (e) {
  console.log(
    `3) abort        -> ${e.name} через ${Math.round(performance.now() - t1)} мс; завантажено ${progress}/3 (замість 3000 мс очікування)`,
  );
}

// 4. Битий JSON
log.length = 0;
try {
  await requestJson(`${base}/corrupt`);
} catch (e) {
  console.log(`4) corrupt JSON -> ${describe(e)}; запитів: ${log.length} (без повторів)`);
}

// Порівняння
console.log("\n=== Sequential vs Concurrent (5 ассетів) ===");
const delays = "250,300,200,320,270";
for (const sequential of [true, false]) {
  const r = await loadAll(`${base}/manifest/${delays}`, { loaders, sequential });
  console.log(
    `${sequential ? "sequential (for..of + await)" : "concurrent (Promise.all)    "}: ${Math.round(r.ms)} мс`,
  );
}
console.log(`сума затримок = ${delays.split(",").map(Number).reduce((a, b) => a + b)} мс, максимум = ${Math.max(...delays.split(",").map(Number))} мс`);

server.closeAllConnections();
server.close();
