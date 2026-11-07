import assert from "node:assert/strict";
import test from "node:test";
import { hashWorld } from "../src/sim/index.ts";
import { runScenario } from "./helpers.ts";

// «Золотий» хеш: 1000 тиків сценарію з seed 7. Той самий хеш має вийти в
// Node і в Chromium (node shared/scripts/determinism-browser.mjs). Якщо тест
// впав після ЗМІНИ симуляції — перевірте, що зміна навмисна, і оновіть число.
export const GOLDEN = { seed: 7, ticks: 1000, hash: 3408780942 };

test("golden: хеш світу після 1000 тиків стабільний", () => {
  const hash = hashWorld(runScenario(GOLDEN.ticks, GOLDEN.seed));
  assert.equal(hash, GOLDEN.hash);
});
