import assert from "node:assert/strict";
import test from "node:test";
import { NetSim } from "../src/netsim.ts";
import { sleep } from "./helpers.ts";

test("netsim: без налаштувань — синхронно", () => {
  const sim = new NetSim();
  let hit = 0;
  sim.pass(() => hit++);
  assert.equal(hit, 1);
});

test("netsim: затримка напрямку = latency/2", async () => {
  const sim = new NetSim();
  sim.configure({ latency: 200 });
  const t0 = performance.now();
  const at = await new Promise<number>((resolve) => sim.pass(() => resolve(performance.now())));
  assert.ok(Math.abs(at - t0 - 100) < 25, `${at - t0}`);
});

test("netsim: drop=100 губить ненадійні, але не надійні", async () => {
  const sim = new NetSim();
  sim.configure({ latency: 0, jitter: 0, drop: 100 });
  let unreliable = 0;
  let reliable = 0;
  for (let i = 0; i < 20; i++) {
    sim.pass(() => unreliable++);
    sim.pass(() => reliable++, { reliable: true });
  }
  await sleep(20);
  assert.equal(unreliable, 0);
  assert.equal(reliable, 20);
  assert.equal(sim.dropped, 20);
});

test("netsim: надійні зберігають порядок навіть при великому джитері", async () => {
  let seed = 1;
  const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const sim = new NetSim({ rng });
  sim.configure({ latency: 20, jitter: 80 });
  const order: number[] = [];
  for (let i = 0; i < 30; i++) sim.pass(() => order.push(i), { reliable: true });
  await sleep(150);
  assert.deepEqual(order, [...Array(30).keys()]);
});

test("netsim: ненадійні можуть переставлятись", async () => {
  let seed = 3;
  const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const sim = new NetSim({ rng });
  sim.configure({ latency: 20, jitter: 100 });
  const order: number[] = [];
  for (let i = 0; i < 30; i++) sim.pass(() => order.push(i));
  await sleep(150);
  assert.equal(order.length, 30);
  assert.notDeepEqual(order, [...Array(30).keys()]);
});

test("netsim: close скасовує таймери", async () => {
  const sim = new NetSim();
  sim.configure({ latency: 100 });
  let hit = 0;
  sim.pass(() => hit++);
  sim.close();
  await sleep(80);
  assert.equal(hit, 0);
});
