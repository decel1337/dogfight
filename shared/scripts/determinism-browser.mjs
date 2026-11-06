// Той самий сценарій у Node і в Chromium: хеші мають збігтися побітово.
// Потрібні esbuild і playwright (глобально або в node_modules).
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(process.env.TOOLS ?? `${here}/../../`);
const { chromium } = require("playwright");
const esbuild = require("esbuild");

const out = path.join(mkdtempSync(path.join(tmpdir(), "det-")), "bundle.js");
await esbuild.build({
  stdin: {
    contents: `import { hashWorld } from "./src/sim/index.js";
      import { runScenario } from "./test/helpers.js";
      window.run = (ticks, seed) => hashWorld(runScenario(ticks, seed));`,
    resolveDir: path.join(here, ".."),
  },
  bundle: true,
  format: "iife",
  outfile: out,
});

const { hashWorld } = await import("../src/sim/index.js");
const { runScenario } = await import("../test/helpers.js");
const node = hashWorld(runScenario(1000, 7));

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent("<body></body>");
await page.addScriptTag({ content: readFileSync(out, "utf8") });
const chrome = await page.evaluate(() => window.run(1000, 7));
await browser.close();

console.log(
  `Node: ${node}\nChromium: ${chrome}\n${node === chrome ? "ЗБІГАЄТЬСЯ" : "РОЗБІЖНІСТЬ"}`,
);
process.exit(node === chrome ? 0 : 1);
