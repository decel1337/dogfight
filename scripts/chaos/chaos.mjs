// Chaos-перевірки живого сервера: node scripts/chaos/chaos.mjs <сценарій> [--target http://host:port]
//   client-kill   — 30 клієнтів, половину обриваємо без close-кадру (terminate)
//   flood         — 1000 сміттєвих повідомлень/с з одного клієнта + нові з'єднання; здорові гравці не страждають
//   server-kill   — SIGKILL сервера (лише локально, без --target): клієнти бачать обрив, після рестарту все працює
// Без --target скрипт сам запускає локальний сервер (потрібен node >=22.12).
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";

const args = process.argv.slice(2);
const scenario = args[0];
const targetIndex = args.indexOf("--target");
const external = targetIndex >= 0 ? args[targetIndex + 1] : null;
const ENTRY = path.resolve(import.meta.dirname, "../../server/src/index.ts");

function startLocal(port) {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", ENTRY], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", LOG_DIR: mkdtempSync(path.join(tmpdir(), "chaos-")), LOG_LEVEL: "warn", MAX_CONNECTIONS_PER_IP: "1000", MAX_PLAYERS_PER_ROOM: "64" },
    stdio: "ignore",
  });
  return child;
}

async function waitReady(base) {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${base}/ready`)).ok) return; } catch {}
    await sleep(100);
  }
  throw new Error("сервер не став ready");
}

const json = async (url, init) => (await fetch(url, init)).json();
const createRoom = (base, name) =>
  json(`${base}/api/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, maxPlayers: 32 }) });

function player(base, roomId, name) {
  const ws = new WebSocket(`${base.replace("http", "ws")}/ws`);
  const state = { snapshots: 0, closed: null, joined: false };
  ws.on("message", (data, isBinary) => {
    if (isBinary) state.snapshots++;
    else if (JSON.parse(data.toString()).type === "joined") state.joined = true;
  });
  ws.on("close", (code) => (state.closed = code));
  ws.on("error", () => {});
  ws.on("open", () => ws.send(JSON.stringify({ v: 1, type: "join", room: roomId, name })));
  return { ws, state };
}

// p99 тика з /metrics (мс) для кімнати
async function tickP99(base, roomId) {
  const text = await (await fetch(`${base}/metrics`)).text();
  const m = new RegExp(`dogfight_tick_work_p99_ms\\{room="${roomId}"\\} ([\\d.e+-]+)`).exec(text);
  return m ? Number(m[1]) : NaN;
}
const metric = async (base, name) => {
  const text = await (await fetch(`${base}/metrics`)).text();
  const m = new RegExp(`^${name} ([\\d.e+-]+)$`, "m").exec(text);
  return m ? Number(m[1]) : NaN;
};

let failed = false;
const check = (ok, message) => { console.log(`${ok ? "PASS" : "FAIL"}  ${message}`); if (!ok) failed = true; };

async function clientKill(base) {
  const room = await createRoom(base, "chaos-kill");
  const players = Array.from({ length: 30 }, (_, i) => player(base, room.id, `P${i}`));
  await sleep(1500);
  check(players.every((p) => p.state.joined), "30 клієнтів зайшли");
  for (const p of players.slice(0, 15)) p.ws.terminate(); // обрив без close-кадру
  await sleep(1500);
  const alive = (await fetch(`${base}/health`)).ok;
  check(alive, "сервер відповідає після обриву 15 клієнтів");
  const connections = await metric(base, "dogfight_connections");
  check(connections === 15, `лишилось 15 з'єднань (метрика: ${connections})`);
  check(players.slice(15).every((p) => p.state.snapshots > 10 && p.state.closed === null), "решта 15 гравців і далі отримують снапшоти");
  players.forEach((p) => p.ws.terminate());
}

async function flood(base) {
  const room = await createRoom(base, "chaos-flood");
  const healthy = [player(base, room.id, "A"), player(base, room.id, "B")];
  await sleep(1500);
  const before = await tickP99(base, room.id);
  const snapsBefore = healthy.map((p) => p.state.snapshots);

  // 1000 сміттєвих повідомлень/с протягом 5 с з одного клієнта (він буде закритий rate limit-ом,
  // тож скрипт підключається знову й знову)
  let sent = 0;
  const end = Date.now() + 5000;
  const garbage = ["not json", "{\"v\":1,\"type\":\"nope\"}", "x".repeat(5000), "\u0000\u0001"];
  while (Date.now() < end) {
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws`);
    ws.on("error", () => {});
    await new Promise((r) => { ws.on("open", r); ws.on("close", r); });
    for (let i = 0; i < 50 && ws.readyState === ws.OPEN; i++) { ws.send(garbage[i % garbage.length]); sent++; }
    await sleep(50); // ≈ 1000/с сумарно
    ws.terminate();
  }
  const during = await tickP99(base, room.id);
  const snapsDuring = healthy.map((p) => p.state.snapshots);
  const rejected = await (await fetch(`${base}/metrics`)).text();
  console.log(`надіслано сміття: ${sent}; tick p99 до=${before} мс, під флудом=${during} мс`);
  check(during < 33, `tick p99 під флудом < 33 мс (${during})`);
  check(snapsDuring.every((n, i) => n - snapsBefore[i] > 100), "здорові гравці отримали >100 снапшотів за час флуду");
  check(healthy.every((p) => p.state.closed === null), "здорові гравці не відключені");
  check(/dogfight_rejections_total\{reason="(invalid_message|rate_limit)"\}/.test(rejected), "відхилення видно в /metrics");
  healthy.forEach((p) => p.ws.terminate());
}

async function serverKill(port, base, child) {
  const room = await createRoom(base, "chaos-sigkill");
  const p = player(base, room.id, "Survivor");
  await sleep(1000);
  check(p.state.joined, "клієнт у грі");
  const t0 = Date.now();
  child.kill("SIGKILL");
  while (p.state.closed === null && Date.now() - t0 < 5000) await sleep(50);
  check(p.state.closed !== null, `клієнт помітив обрив за ${Date.now() - t0} мс (код ${p.state.closed})`);
  const again = startLocal(port);
  try {
    await waitReady(base);
    const fresh = player(base, room.id, "Survivor");
    await sleep(800);
    check(fresh.state.closed === 4004, `після рестарту стара кімната зникла: код ${fresh.state.closed} (4004 -> клієнт повертається в лобі)`);
    const newRoom = await createRoom(base, "after-restart");
    const again2 = player(base, newRoom.id, "Survivor");
    await sleep(800);
    check(again2.state.joined, "у новій кімнаті гра відновлюється");
    again2.ws.terminate();
  } finally { again.kill("SIGTERM"); }
}

if (!["client-kill", "flood", "server-kill"].includes(scenario ?? "")) {
  console.error("сценарії: client-kill | flood | server-kill [--target URL]");
  process.exit(2);
}
const port = 3900 + Math.floor(Math.random() * 90);
const base = external ?? `http://127.0.0.1:${port}`;
let child = null;
if (!external) { child = startLocal(port); }
try {
  await waitReady(base);
  if (scenario === "client-kill") await clientKill(base);
  if (scenario === "flood") await flood(base);
  if (scenario === "server-kill") {
    if (external) throw new Error("server-kill працює лише локально");
    await serverKill(port, base, child);
  }
} finally {
  child?.kill("SIGTERM");
}
process.exit(failed ? 1 : 0);
