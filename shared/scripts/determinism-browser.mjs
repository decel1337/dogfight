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
    contents: `import { hashWorld } from "./src/sim/index.ts";
      import { runScenario } from "./test/helpers.ts";
      window.run = (ticks, seed) => hashWorld(runScenario(ticks, seed));`,
    resolveDir: path.join(here, ".."),
  },
  bundle: true, format: "iife", outfile: out,
  // test/helpers.ts імпортує node:assert; у браузері потрібен лише assert.fail.
  plugins: [{
    name: "assert-stub",
    setup(build) {
      build.onResolve({ filter: /^node:assert\/strict$/ }, () => ({ path: "assert", namespace: "stub" }));
      build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
        contents: "export default { fail(m) { throw new Error(m); } };",
      }));
    },
  }],
});

const { hashWorld } = await import("../src/sim/index.ts");
const { runScenario } = await import("../test/helpers.ts");
const node = hashWorld(runScenario(1000, 7));

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent("<body></body>");
await page.addScriptTag({ content: readFileSync(out, "utf8") });
const chrome = await page.evaluate(() => window.run(1000, 7));
await browser.close();

console.log(`Node: ${node}\nChromium: ${chrome}\n${node === chrome ? "ЗБІГАЄТЬСЯ" : "РОЗБІЖНІСТЬ"}`);
process.exit(node === chrome ? 0 : 1);
