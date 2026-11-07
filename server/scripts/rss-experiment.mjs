// Backpressure-доказ (Lab 04, M3): тримаємо повільного клієнта на великому
// логу й міряємо rss сервера. pipeline -> крива пласка; readFile -> стрибок.
//
//   node scripts/rss-experiment.mjs [МБ=200] [МБ/с=8]
//
// Результат: ../docs/rss-backpressure.svg і .csv. Для цього експерименту
// сервер запускається з ENABLE_DEBUG_ROUTES=1 (маршрут -naive лише для
// порівняння; у звичайному режимі він вимкнений).
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { generateLog } from "./gen-log.ts";

const MB = 1024 * 1024;
const SIZE_MB = Number(process.argv[2] ?? 200);
const RATE_MBS = Number(process.argv[3] ?? 8);
const ROOT = path.resolve(import.meta.dirname, "..");
const DOCS = path.resolve(ROOT, "../docs");

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function getJson(port, pathname) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`);
  return res.json();
}

async function startServer(logDir) {
  const port = await freePort();
  const child = spawn("node", ["src/index.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      LOG_DIR: logDir,
      ENABLE_DEBUG_ROUTES: "1",
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      await getJson(port, "/health");
      return { port, child };
    } catch {
      await sleep(50);
    }
  }
  throw new Error("сервер не стартував");
}

// Повільний клієнт: читає не швидше за RATE_MBS. `for await` призупиняє
// сокет між шматками, тож TCP-вікно заповнюється і сервер мусить чекати.
function slowDownload(port, url) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: url }, async (res) => {
        let received = 0;
        let debt = 0;
        try {
          for await (const chunk of res) {
            received += chunk.length;
            debt += chunk.length / (RATE_MBS * MB);
            if (debt >= 0.01) {
              await sleep(debt * 1000);
              debt = 0;
            }
          }
          resolve(received);
        } catch (error) {
          reject(error);
        }
      })
      .on("error", reject);
  });
}

async function measure(label, route, logDir, id) {
  const { port, child } = await startServer(logDir);
  const samples = [];
  const t0 = performance.now();
  const base = (await getJson(port, "/health")).rss;

  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const { rss } = await getJson(port, "/health");
      samples.push({
        t: (performance.now() - t0) / 1000,
        mb: rss / MB,
      });
      await sleep(250);
    }
  })();

  const bytes = await slowDownload(port, `${route}/${id}`);
  sampling = false;
  await sampler;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));

  const peak = Math.max(...samples.map((s) => s.mb));
  const result = {
    label,
    samples,
    baseMb: base / MB,
    peakMb: peak,
    seconds: (performance.now() - t0) / 1000,
    receivedMb: bytes / MB,
  };
  console.log(
    `${label.padEnd(22)} база ${result.baseMb.toFixed(0)} МБ, пік ${peak.toFixed(0)} МБ ` +
      `(+${(peak - result.baseMb).toFixed(0)} МБ), ${result.seconds.toFixed(0)} с, ` +
      `отримано ${result.receivedMb.toFixed(0)} МБ`,
  );
  return result;
}

function toSvg(runs) {
  const W = 760;
  const H = 360;
  const m = { l: 60, r: 20, t: 36, b: 44 };
  const maxT = Math.max(...runs.flatMap((r) => r.samples.map((s) => s.t)));
  const maxY = Math.ceil(
    Math.max(...runs.flatMap((r) => r.samples.map((s) => s.mb))) / 50,
  ) * 50;
  const x = (t) => m.l + (t / maxT) * (W - m.l - m.r);
  const y = (v) => H - m.b - (v / maxY) * (H - m.t - m.b);
  const colors = ["#1a7f37", "#cf222e"];

  const grid = [];
  for (let v = 0; v <= maxY; v += 50) {
    grid.push(
      `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" stroke="#d0d7de"/>`,
      `<text x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`,
    );
  }
  const ticks = [];
  for (let t = 0; t <= maxT; t += 5) {
    ticks.push(
      `<text x="${x(t)}" y="${H - m.b + 18}" text-anchor="middle">${t}</text>`,
    );
  }
  const lines = runs.map((run, i) => {
    const pts = run.samples.map((s) => `${x(s.t).toFixed(1)},${y(s.mb).toFixed(1)}`);
    return `<polyline fill="none" stroke="${colors[i]}" stroke-width="2.5" points="${pts.join(" ")}"/>`;
  });
  const legend = runs.map(
    (run, i) =>
      `<rect x="${m.l + i * 250}" y="10" width="14" height="14" fill="${colors[i]}"/>` +
      `<text x="${m.l + i * 250 + 20}" y="22">${run.label}: пік ${run.peakMb.toFixed(0)} МБ</text>`,
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="monospace" font-size="12" role="img" aria-label="rss сервера під час повільного завантаження логу ${SIZE_MB} МБ">
<rect width="${W}" height="${H}" fill="#ffffff"/>
${grid.join("\n")}
${ticks.join("\n")}
<text x="${(W + m.l) / 2}" y="${H - 6}" text-anchor="middle">секунди</text>
<text transform="translate(14 ${H / 2}) rotate(-90)" text-anchor="middle">rss сервера, МБ</text>
${lines.join("\n")}
${legend.join("\n")}
</svg>
`;
}

const dir = await mkdtemp(path.join(os.tmpdir(), "rss-exp-"));
try {
  const id = "synthetic";
  console.log(`генерую ${SIZE_MB} МБ логу, клієнт читає ${RATE_MBS} МБ/с…`);
  await generateLog(path.join(dir, `${id}.ndjson`), SIZE_MB);

  const runs = [];
  runs.push(await measure("pipeline (стрім)", "/api/replays", dir, id));
  runs.push(await measure("readFile (в пам'ять)", "/api/replays-naive", dir, id));

  await mkdir(DOCS, { recursive: true });
  await writeFile(path.join(DOCS, "rss-backpressure.svg"), toSvg(runs));
  const csv = ["run,seconds,rss_mb"];
  for (const run of runs) {
    for (const s of run.samples) {
      csv.push(`${run.label},${s.t.toFixed(2)},${s.mb.toFixed(1)}`);
    }
  }
  await writeFile(path.join(DOCS, "rss-backpressure.csv"), `${csv.join("\n")}\n`);
  console.log("графік: docs/rss-backpressure.svg");
} finally {
  await rm(dir, { recursive: true, force: true });
}
