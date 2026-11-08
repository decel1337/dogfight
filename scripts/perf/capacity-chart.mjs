// SVG-графік ємності з perf/load-*.json: tick p99 (мс) від N клієнтів, лінія бюджету 33 мс.
import { readFileSync, writeFileSync } from "node:fs";
const [before, after, out] = process.argv.slice(2);
const sets = [["до", JSON.parse(readFileSync(before, "utf8")), "#d1495b"], ["після", JSON.parse(readFileSync(after, "utf8")), "#2e86ab"]];
const W = 640, H = 360, L = 60, R = 20, T = 30, B = 50, XMAX = 256, YMAX = 40;
const x = (n) => L + (n / XMAX) * (W - L - R), y = (v) => H - B - (v / YMAX) * (H - T - B);
let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="sans-serif" font-size="12"><rect width="${W}" height="${H}" fill="#fff"/>`;
for (let v = 0; v <= YMAX; v += 10) s += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#ddd"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
for (const n of [8, 32, 64, 128, 192, 256]) s += `<text x="${x(n)}" y="${H - B + 18}" text-anchor="middle">${n}</text>`;
s += `<line x1="${L}" x2="${W - R}" y1="${y(33.3)}" y2="${y(33.3)}" stroke="#444" stroke-dasharray="5 4"/><text x="${W - R}" y="${y(33.3) - 5}" text-anchor="end">бюджет 33 мс (2 тики)</text>`;
sets.forEach(([name, rows, color], i) => {
  s += `<polyline fill="none" stroke="${color}" stroke-width="2.5" points="${rows.map((r) => `${x(r.n)},${y(r.tickP99)}`).join(" ")}"/>`;
  for (const r of rows) s += `<circle cx="${x(r.n)}" cy="${y(r.tickP99)}" r="3.5" fill="${color}"/>`;
  s += `<text x="${L + 10 + i * 90}" y="${T - 10}" fill="${color}">● ${name}</text>`;
});
s += `<text x="${W / 2}" y="${H - 8}" text-anchor="middle">клієнтів N (одна кімната)</text><text x="14" y="${H / 2}" transform="rotate(-90 14 ${H / 2})" text-anchor="middle">tick p99, мс</text></svg>`;
writeFileSync(out, s);
