import assert from "node:assert/strict";
import { test } from "vitest";
import { validateBotCount } from "../src/app.ts";
import { BotPool, MAX_BOTS } from "../src/bots.ts";
import { Match } from "../src/match.ts";
import { Room } from "../src/rooms.ts";
import { createRoom, sleep, withApp } from "./helpers.ts";

function makeMatch(): Match {
  const room = new Room({
    id: "r-1",
    name: "t",
    maxPlayers: 4,
    arena: { width: 1200, height: 800 },
  });
  return new Match({ room, seed: 7 });
}

test("боти: шлють input через receiveInput, кораблі рухаються і стріляють", () => {
  const match = makeMatch();
  const pool = new BotPool(match);
  assert.equal(pool.add(4), 4);
  match.stop(); // add() запускає таймер; тут тикаємо вручну
  match.tick(); // перший кадр: боти ще не бачили снапшота
  for (let i = 0; i < 90; i++) match.tick();
  assert.equal(match.rejected, 0, "боти не порушують seq/чергу");
  assert.equal(match.playerCount, 4);
  const bullets = [...match.world.ofKind("bullet")].length;
  assert.ok(bullets > 0, "хоч одна куля в польоті");
  pool.dispose();
  match.stop();
  assert.equal(match.playerCount, 0);
});

test("боти детерміновані при однаковому seed", () => {
  const hash = (): string => {
    const match = makeMatch();
    new BotPool(match).add(3);
    match.stop();
    for (let i = 0; i < 120; i++) match.tick();
    return JSON.stringify(match.world.snapshot());
  };
  assert.equal(hash(), hash());
});

test("пул не перевищує MAX_BOTS", () => {
  const match = makeMatch();
  const pool = new BotPool(match);
  pool.add(MAX_BOTS + 50);
  match.stop();
  assert.equal(pool.size, MAX_BOTS);
  pool.dispose();
});

test("validateBotCount відхиляє сміття", () => {
  assert.equal(validateBotCount({ count: 8 }), 8);
  for (const bad of [
    null,
    {},
    { count: 0 },
    { count: 1.5 },
    { count: "8" },
    { count: MAX_BOTS + 1 },
  ]) {
    assert.throws(() => validateBotCount(bad), { status: 400 });
  }
});

test("POST /api/rooms/:id/bots додає ботів, DELETE прибирає, 404/400/405", async () => {
  await withApp({}, async (ctx) => {
    const room = await createRoom(ctx);
    const url = `${ctx.http}/api/rooms/${room.id}/bots`;
    const post = (body: unknown) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const ok = await post({ count: 5 });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { bots: 5 });
    await sleep(150);
    const stats = (await (await fetch(`${ctx.http}/api/stats`)).json()) as {
      matches: { players: number; tick: number }[];
    };
    assert.equal(stats.matches[0]?.players, 5);
    assert.ok((stats.matches[0]?.tick ?? 0) > 0, "матч стартував без людей");

    assert.equal((await post({ count: 0 })).status, 400);
    assert.equal(
      (
        await fetch(`${ctx.http}/api/rooms/r-nope/bots`, {
          method: "POST",
          body: "{}",
        })
      ).status,
      404,
    );
    assert.equal((await fetch(url)).status, 405);
    assert.deepEqual(await (await fetch(url, { method: "DELETE" })).json(), {
      bots: 0,
    });
  });
});
