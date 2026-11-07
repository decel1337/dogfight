// Демо event loop (Lab 04, M4): поки HTTP-запит блокує потік на 300 мс,
// чат іншого клієнта «зависає». Міряємо затримку доставки повідомлень
// між двома WebSocket-клієнтами в трьох фазах:
//   1) спокій;  2) GET /api/slow (синхронний busy-loop на сервері);
//   3) GET /api/slow-async (чекає 300 мс, але не блокує цикл).
//
//   node scripts/eventloop-demo.mjs
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";

const ROOT = path.resolve(import.meta.dirname, "..");
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const port = await freePort();
const server = spawn("node", ["src/index.ts"], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(port),
    LOG_DIR: path.join(ROOT, "logs", "demo"),
    ENABLE_DEBUG_ROUTES: "1",
    RATE_PER_SEC: "200",
    RATE_BURST: "400",
  },
  stdio: "ignore",
});
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) {
  try {
    await fetch(`${base}/health`);
    break;
  } catch {
    await sleep(50);
  }
}

const room = await (
  await fetch(`${base}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "demo" }),
  })
).json();

function client(name) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  ws.on("error", console.error);
  const send = (type, payload) =>
    ws.send(JSON.stringify({ v: 1, type, ...payload }));
  const ready = new Promise((resolve) => {
    ws.on("open", () => send("join", { room: room.id, name }));
    ws.on("message", (raw) => {
      if (JSON.parse(raw).type === "joined") resolve();
    });
  });
  return { ws, send, ready };
}

const sender = client("sender");
const receiver = client("receiver");
await Promise.all([sender.ready, receiver.ready]);

const latencies = [];
receiver.ws.on("message", (raw) => {
  const msg = JSON.parse(raw);
  if (msg.type !== "chat") return;
  latencies.push(performance.now() - Number(msg.text.split(":")[1]));
});

const ticker = setInterval(
  () => sender.send("chat", { text: `ts:${performance.now()}` }),
  20,
);

async function phase(title, action) {
  latencies.length = 0;
  await action();
  await sleep(200);
  const sorted = [...latencies].sort((a, b) => a - b);
  const pct = (p) => sorted[Math.floor((sorted.length - 1) * p)] ?? NaN;
  console.log(
    `${title.padEnd(34)} повідомлень: ${String(sorted.length).padStart(3)}  ` +
      `p50 ${pct(0.5).toFixed(1)} мс  макс ${sorted.at(-1).toFixed(1)} мс`,
  );
}

await phase("1) спокій (1 с)", () => sleep(1000));
await phase("2) /api/slow (busy-loop 300 мс)", () => fetch(`${base}/api/slow`));
await phase("3) /api/slow-async (await 300 мс)", () =>
  fetch(`${base}/api/slow-async`),
);

clearInterval(ticker);
sender.ws.close();
receiver.ws.close();
server.kill("SIGTERM");
await new Promise((resolve) => server.once("exit", resolve));
