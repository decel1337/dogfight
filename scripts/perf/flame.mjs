// Flame/icicle-діаграма з .cpuprofile -> SVG (+ PNG, якщо знайдено playwright).
// node scripts/perf/flame.mjs in.cpuprofile out.svg [title]
import { readFileSync, writeFileSync } from "node:fs";
const [input, output, title = "flame"] = process.argv.slice(2);
const prof = JSON.parse(readFileSync(input, "utf8"));
const nodes = new Map(prof.nodes.map((n) => [n.id, { ...n, self: 0, total: 0 }]));
prof.samples.forEach((id, i) => { nodes.get(id).self += prof.timeDeltas[i] ?? 0; });
const calc = (n) => (n.total = n.self + (n.children ?? []).reduce((a, c) => a + calc(nodes.get(c)), 0));
const root = nodes.get(prof.nodes[0].id);
calc(root);
const busy = root.total - ([...nodes.values()].find((n) => n.callFrame.functionName === "(idle)")?.total ?? 0);
const W = 1400, H = 18, MIN = root.total * 0.004;
const rects = [];
let maxDepth = 0;
(function layout(n, x, depth) {
  maxDepth = Math.max(maxDepth, depth);
  const w = (n.total / root.total) * W;
  const name = n.callFrame.functionName || "(anonymous)";
  if (n.total >= MIN && name !== "(idle)" && name !== "(root)") {
    const hue = name.startsWith("(") ? 210 : 20 + ((name.length * 37) % 40);
    rects.push(`<g><title>${name} — ${(n.total / 1000).toFixed(0)} ms total, ${(n.self / 1000).toFixed(0)} ms self</title><rect x="${x.toFixed(1)}" y="${depth * H + 24}" width="${Math.max(w - 0.5, 0.5).toFixed(1)}" height="${H - 1}" fill="hsl(${hue} 70% 62%)"/>${w > 60 ? `<text x="${(x + 3).toFixed(1)}" y="${depth * H + 36}" font-size="11" font-family="monospace" fill="#111">${name.slice(0, Math.floor(w / 6.5)).replace(/&/g, "&amp;").replace(/</g, "&lt;")}</text>` : ""}</g>`);
  }
  let cx = x;
  for (const c of (n.children ?? []).map((id) => nodes.get(id)).sort((a, b) => b.total - a.total)) {
    layout(c, cx, depth + 1);
    cx += (c.total / root.total) * W;
  }
})(root, 0, 0);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${(maxDepth + 1) * H + 32}" style="background:#fff"><text x="4" y="16" font-size="13" font-family="monospace" fill="#111">${title} — CPU зайнятий ${(busy / 1000).toFixed(0)} мс із ${(root.total / 1000).toFixed(0)} мс (idle не показано; ширина ∝ час)</text>${rects.join("")}</svg>`;
writeFileSync(output, svg);
let chromium;
try { chromium = (await import("@playwright/test")).chromium; } catch {}
if (!chromium) { try { chromium = (await import("playwright")).chromium; } catch {} }
if (!chromium && process.env.PLAYWRIGHT_PATH) { const { createRequire } = await import("node:module"); chromium = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH).chromium; }
if (chromium) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: W, height: (maxDepth + 1) * H + 32 }, deviceScaleFactor: 1 });
  await page.setContent(`<body style="margin:0">${svg}</body>`);
  await page.screenshot({ path: output.replace(/\.svg$/, ".png") });
  await browser.close();
}
