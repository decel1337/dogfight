import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { validateRoomInput } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { type RoomJson, createRoom, withApp } from "./helpers.ts";

// Відповіді нашого API в тестах читаємо через явні форми.
const readJson = async <T>(res: Response): Promise<T> => (await res.json()) as T;

const postJson = (url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

test("GET /health", async () => {
  await withApp({}, async ({ http }) => {
    const res = await fetch(`${http}/health`);
    assert.equal(res.status, 200);
    const body = await readJson<{ status: string; rss: unknown; rooms: number }>(res);
    assert.equal(body.status, "ok");
    assert.equal(typeof body.rss, "number");
    assert.equal(body.rooms, 0);
  });
});

test("POST /api/rooms створює кімнату, GET /api/rooms показує її", async () => {
  await withApp({}, async ({ http }) => {
    const res = await postJson(`${http}/api/rooms`, { name: "Alpha", maxPlayers: 3 });
    assert.equal(res.status, 201);
    const room = await readJson<RoomJson>(res);
    assert.equal(room.name, "Alpha");
    assert.equal(room.maxPlayers, 3);
    assert.equal(res.headers.get("location"), `/api/rooms/${room.id}`);

    const list = await readJson<RoomJson[]>(await fetch(`${http}/api/rooms`));
    assert.deepEqual(list.map((r) => r.id), [room.id]);
    assert.equal(list[0]?.players, 0);
  });
});

test("POST /api/rooms: валідація входу (400/413/415/405)", async () => {
  await withApp({ MAX_BODY_BYTES: "256" }, async ({ http }) => {
    const bad = [
      { name: "" },
      { name: "x".repeat(33) },
      { name: 42 },
      { maxPlayers: 0 },
      { maxPlayers: 9 },
      { maxPlayers: 2.5 },
      { arena: { width: 10, height: 10 } },
      [],
    ];
    for (const body of bad) {
      const res = await postJson(`${http}/api/rooms`, body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal((await postJson(`${http}/api/rooms`, "{oops")).status, 400);

    const big = await postJson(`${http}/api/rooms`, { name: "x".repeat(2000) });
    assert.equal(big.status, 413);

    const wrongType = await fetch(`${http}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    assert.equal(wrongType.status, 415);

    const del = await fetch(`${http}/api/rooms`, { method: "DELETE" });
    assert.equal(del.status, 405);
    assert.match(del.headers.get("allow") ?? "", /POST/);
  });
});

test("POST /api/rooms: ліміт кімнат -> 429", async () => {
  await withApp({ MAX_ROOMS: "2" }, async (ctx) => {
    await createRoom(ctx);
    await createRoom(ctx);
    const res = await postJson(`${ctx.http}/api/rooms`, { name: "third" });
    assert.equal(res.status, 429);
  });
});

test("validateRoomInput копіює лише відомі поля", () => {
  const config = loadConfig({});
  const input = validateRoomInput({ name: " A ", evil: "x", __proto__: { polluted: 1 } }, config);
  assert.deepEqual(input, { name: "A" });
  assert.equal(Reflect.get({}, "polluted"), undefined);
});

test("невідомий /api/* -> 404 JSON, без клієнта -> підказка", async () => {
  await withApp({}, async ({ http }) => {
    const api = await fetch(`${http}/api/nope`);
    assert.equal(api.status, 404);
    assert.equal((await readJson<{ error: string }>(api)).error, "не знайдено");

    const page = await fetch(`${http}/`);
    assert.equal(page.status, 404);
  });
});

test("GET /api/replays/:id стрімить файл; список; traversal блокується", async () => {
  await withApp({}, async ({ http, logDir }) => {
    const content = `${Array.from({ length: 2000 }, (_, i) => JSON.stringify({ i })).join("\n")}\n`;
    await writeFile(path.join(logDir, "demo-1.ndjson"), content);

    const list = await readJson<{ id: string; bytes: number }[]>(await fetch(`${http}/api/replays`));
    assert.ok(list.some((r) => r.id === "demo-1" && r.bytes === content.length));

    const res = await fetch(`${http}/api/replays/demo-1`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/x-ndjson");
    assert.equal(await res.text(), content);

    assert.equal((await fetch(`${http}/api/replays/missing`)).status, 404);
    assert.equal((await fetch(`${http}/api/replays/..%2F..%2Fetc%2Fpasswd`)).status, 400);
    assert.equal((await fetch(`${http}/api/replays/a.b`)).status, 400);
  });
});

test("debug-маршрути вимкнені за замовчуванням", async () => {
  await withApp({}, async ({ http }) => {
    assert.equal((await fetch(`${http}/api/slow`)).status, 404);
    assert.equal((await fetch(`${http}/api/replays-naive/x`)).status, 404);
  });
});

test("event loop: синхронний /api/slow затримує ВСІ таймери, /api/slow-async — ні", async () => {
  // Сервер у цьому ж процесі, тож таймер у тесті ділить цикл подій із
  // обробником: якщо обробник блокує, таймер на 20 мс спрацює пізно.
  await withApp({ ENABLE_DEBUG_ROUTES: "1" }, async ({ http }) => {
    const timerLateness = async (slowPath: string): Promise<number> => {
      const slow = fetch(`${http}${slowPath}`);
      const t0 = performance.now();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const elapsed = performance.now() - t0;
      await slow;
      return elapsed;
    };
    const blocked = await timerLateness("/api/slow");
    const free = await timerLateness("/api/slow-async");
    assert.ok(blocked > 150, `таймер 20 мс під sync-блокуванням: ${blocked.toFixed(0)} мс`);
    assert.ok(free < 100, `таймер 20 мс під async-очікуванням: ${free.toFixed(0)} мс`);
  });
});
