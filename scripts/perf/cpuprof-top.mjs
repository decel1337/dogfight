// Топ функцій за self-time з .cpuprofile: node scripts/perf/cpuprof-top.mjs file [N]
import { readFileSync } from "node:fs";
const [file, top = "12"] = process.argv.slice(2);
const prof = JSON.parse(readFileSync(file, "utf8"));
const self = new Map();
const byId = new Map(prof.nodes.map((n) => [n.id, n]));
const dt = prof.timeDeltas;
for (let i = 0; i < prof.samples.length; i++) {
  const n = byId.get(prof.samples[i]);
  const f = n.callFrame;
  const key = `${f.functionName || "(anon)"} ${f.url.split("/").slice(-2).join("/")}:${f.lineNumber + 1}`;
  self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0));
}
const total = [...self.values()].reduce((a, b) => a + b, 0);
const rows = [...self].sort((a, b) => b[1] - a[1]).slice(0, Number(top));
for (const [k, v] of rows) console.log(`${(v / 1000).toFixed(0).padStart(7)} ms  ${((v / total) * 100).toFixed(1).padStart(5)}%  ${k}`);
