// Навантажувальний тест: піднімає ПРОЦЕС сервера (як у проді), підключає N
// безголових WS-клієнтів (бінарний кодек, input 30 Гц, стрільба) і міряє:
//   tick p99 (workMs, /api/stats), jitter p99, ELU, RSS, байти/с на сервері.
// Запуск: node scripts/perf/loadtest.mjs [--n 8,32,64,128] [--secs 15] [--layout single|rooms] [--bots 0]
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { encodeInput } from "@dogfight/shared/codec";

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const NS = arg("n", "8,32,64,128").split(",").map(Number);
const SECS = Number(arg("secs", "15"));
const LAYOUT = arg("layout", "single"); // single: одна кімната з N; rooms: кімнати по 8
const OUT = arg("out", "");
const PORT = Number(arg("port", "3921"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const serverEntry = path.resolve(import.meta.dirname, "../../server/src/index.ts");

async function runOnce(n) {
  const logDir = mkdtempSync(path.join(tmpdir(), "lt-"));
  const server = spawn(
    process.execPath,
    [...(process.env.SERVER_FLAGS?.split(" ").filter(Boolean) ?? []), "--experimental-strip-types", "--disable-warning=ExperimentalWarning", serverEntry],
    {
      env: {
        ...process.env,
        PORT: String(PORT), HOST: "127.0.0.1", LOG_DIR: logDir,
        MAX_PLAYERS_PER_ROOM: LAYOUT === "single" ? String(Math.max(8, n)) : "8",
        MAX_ROOMS: "100", STATIC_DIR: logDir,
      },
      stdio: "ignore",
    },
  );
  const base = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* ще не слухає */ }
    await sleep(100);
  }
  const post = async (url, body) =>
    (await fetch(base + url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();

  const roomCount = LAYOUT === "single" ? 1 : Math.ceil(n / 8);
  const rooms = [];
  for (let i = 0; i < roomCount; i++) rooms.push(await post("/api/rooms", { name: `lt${i}`, maxPlayers: LAYOUT === "single" ? Math.max(8, n) : 8 }));

  let bytes = 0, frames = 0, ready = 0;
  const sockets = [];
  const timers = [];
  for (let i = 0; i < n; i++) {
    const room = rooms[i % roomCount];
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    ws.binaryType = "nodebuffer";
    let seq = 0;
    ws.on("open", () => ws.send(JSON.stringify({ v: 1, type: "join", room: room.id, name: `c${i}`, codec: "binary" })));
    ws.on("message", (data, isBinary) => {
      bytes += data.length; frames++;
      if (!isBinary) {
        if (JSON.parse(data.toString()).type === "joined" && ++ready) {
          timers.push(setInterval(() => {
            if (ws.readyState !== ws.OPEN) return;
            ws.send(encodeInput({ type: "input", seq: ++seq, tick: 0, thrust: seq % 3 ? 1 : 0, turn: [-1, 0, 1][(seq >> 4) % 3], fire: seq % 2 ? 1 : 0 }));
          }, 1000 / 30));
        }
      }
    });
    ws.on("error", () => {});
    sockets.push(ws);
    if (i % 16 === 15) await sleep(20);
  }
  for (let i = 0; i < 100 && ready < n; i++) await sleep(100);

  await sleep(3000); // прогрів JIT
  const stats = async () => (await (await fetch(`${base}/api/stats`)).json());
  const s0 = await stats(); const b0 = bytes; const t0 = performance.now();
  await sleep(SECS * 1000);
  const s1 = await stats(); const secs = (performance.now() - t0) / 1000;

  const worst = (key) => Math.max(...s1.matches.map((m) => m.ticker?.[key]?.p99 ?? 0));
  const elu = (s1.process.elu.active - s0.process.elu.active) /
    ((s1.process.elu.active - s0.process.elu.active) + (s1.process.elu.idle - s0.process.elu.idle));
  const row = {
    n, layout: LAYOUT, joined: ready,
    tickP99: worst("workMs"), tickAvg: +(s1.matches.reduce((a, m) => a + (m.ticker?.workMs?.avg ?? 0), 0) / s1.matches.length).toFixed(3),
    tickMax: Math.max(...s1.matches.map((m) => m.ticker?.workMs?.max ?? 0)),
    jitterP99: worst("jitterMs"), skipped: s1.matches.reduce((a, m) => a + (m.ticker?.skipped ?? 0), 0),
    elu: +elu.toFixed(3), rssMb: s1.process.rssMb, kbPerSec: Math.round((bytes - b0) / 1024 / secs),
  };
  for (const t of timers) clearInterval(t);
  for (const ws of sockets) ws.terminate();
  server.kill("SIGTERM");
  await new Promise((r) => server.once("exit", r));
  return row;
}

const rows = [];
for (const n of NS) {
  const row = await runOnce(n);
  rows.push(row);
  console.log(JSON.stringify(row));
}
if (OUT) writeFileSync(OUT, JSON.stringify(rows, null, 2));
