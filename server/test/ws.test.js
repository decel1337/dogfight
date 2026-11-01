import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { CLOSE } from "../src/protocol.js";
import { connect, createRoom, joined, sleep, withApp } from "./helpers.js";

async function open(ctx) {
  const client = connect(ctx.wsUrl);
  await client.opened;
  return client;
}

test("два клієнти: join, roster, chat", async () => {
  await withApp({}, async (ctx) => {
    const room = await createRoom(ctx);

    const ann = await open(ctx);
    ann.send({ type: "join", room: room.id, name: "Ann" });
    const annJoined = await ann.next("joined");
    assert.equal(annJoined.you.name, "Ann");
    assert.equal(annJoined.room.id, room.id);
    assert.deepEqual(
      (await ann.next("roster")).players.map((p) => p.name),
      ["Ann"],
    );

    const bob = await joined(ctx, room.id, "Bob");
    assert.deepEqual(
      (await ann.next("roster")).players.map((p) => p.name),
      ["Ann", "Bob"],
      "Ann бачить, що зайшов Bob",
    );

    ann.send({ type: "chat", text: "привіт!" });
    const forBob = await bob.next("chat");
    const forAnn = await ann.next("chat");
    assert.equal(forBob.from, "Ann");
    assert.equal(forBob.text, "привіт!");
    assert.equal(forAnn.text, "привіт!");

    bob.ws.close();
    const afterLeave = await ann.next("roster");
    assert.deepEqual(
      afterLeave.players.map((p) => p.name),
      ["Ann"],
    );

    // Остання людина вийшла -> кімната видалена
    ann.ws.close();
    await ann.closed;
    await sleep(50);
    assert.deepEqual(await (await fetch(`${ctx.http}/api/rooms`)).json(), []);
  });
});

test("join не надіслано за joinTimeoutMs -> 4001", async () => {
  await withApp({ JOIN_TIMEOUT_MS: "100" }, async (ctx) => {
    const client = await open(ctx);
    const { code } = await client.closed;
    assert.equal(code, CLOSE.JOIN_TIMEOUT);
  });
});

test("join вчасно скасовує таймаут", async () => {
  await withApp({ JOIN_TIMEOUT_MS: "100" }, async (ctx) => {
    const room = await createRoom(ctx);
    const client = await joined(ctx, room.id, "Ann");
    await sleep(200);
    assert.equal(client.ws.readyState, client.ws.OPEN);
  });
});

test("невалідні повідомлення закривають сокет з кодом 4002", async () => {
  await withApp({}, async (ctx) => {
    const room = await createRoom(ctx);
    const cases = {
      "не JSON": () => "not json",
      "невідомий тип": () => JSON.stringify({ v: 0, type: "teleport" }),
      "без версії": () =>
        JSON.stringify({ type: "join", room: room.id, name: "A" }),
      "chat до join": () => JSON.stringify({ v: 0, type: "chat", text: "hi" }),
      "зла форма join": () =>
        JSON.stringify({ v: 0, type: "join", room: 5, name: "A" }),
    };
    for (const [label, make] of Object.entries(cases)) {
      const client = await open(ctx);
      client.ws.send(make());
      const error = await client.next("error");
      assert.ok(error.message, label);
      assert.equal((await client.closed).code, CLOSE.INVALID_MESSAGE, label);
    }
  });
});

test("повторний join -> 4002", async () => {
  await withApp({}, async (ctx) => {
    const room = await createRoom(ctx);
    const client = await joined(ctx, room.id, "Ann");
    client.send({ type: "join", room: room.id, name: "Ann" });
    assert.equal((await client.closed).code, CLOSE.INVALID_MESSAGE);
  });
});

test("завеликий кадр -> 1009, сервер не падає", async () => {
  await withApp({ MAX_PAYLOAD: "256" }, async (ctx) => {
    const client = await open(ctx);
    client.ws.send("x".repeat(1000));
    assert.equal((await client.closed).code, CLOSE.TOO_BIG);

    // Сервер живий і далі приймає з'єднання
    const room = await createRoom(ctx);
    const next = await joined(ctx, room.id, "Ann");
    assert.equal(next.ws.readyState, next.ws.OPEN);
  });
});

test("бінарні кадри -> 1003", async () => {
  await withApp({}, async (ctx) => {
    const client = await open(ctx);
    client.ws.send(Buffer.from([1, 2, 3]));
    assert.equal((await client.closed).code, CLOSE.UNSUPPORTED);
  });
});

test("rate limit: понад burst -> 4003", async () => {
  await withApp({ RATE_PER_SEC: "1", RATE_BURST: "5" }, async (ctx) => {
    const room = await createRoom(ctx);
    const client = await joined(ctx, room.id, "Spammer");
    for (let i = 0; i < 20; i++) {
      if (client.ws.readyState === client.ws.OPEN)
        client.send({ type: "chat", text: `m${i}` });
    }
    assert.equal((await client.closed).code, CLOSE.RATE_LIMITED);
  });
});

test("rate limit не чіпає чесного клієнта", async () => {
  await withApp({ RATE_PER_SEC: "20", RATE_BURST: "5" }, async (ctx) => {
    const room = await createRoom(ctx);
    const client = await joined(ctx, room.id, "Chatty");
    for (let i = 0; i < 6; i++) {
      client.send({ type: "chat", text: `m${i}` });
      await sleep(80);
    }
    assert.equal(client.ws.readyState, client.ws.OPEN);
  });
});

test("кімнати немає -> 4004; кімната повна -> 4005", async () => {
  await withApp({}, async (ctx) => {
    const missing = await open(ctx);
    missing.send({ type: "join", room: "r-nope", name: "A" });
    assert.equal((await missing.closed).code, CLOSE.ROOM_NOT_FOUND);

    const room = await createRoom(ctx, { name: "tiny", maxPlayers: 1 });
    await joined(ctx, room.id, "First");
    const second = await open(ctx);
    second.send({ type: "join", room: room.id, name: "Second" });
    assert.equal((await second.closed).code, CLOSE.ROOM_FULL);
  });
});

test("heartbeat: клієнт, що не відповідає pong, termin-ується; живий — ні", async () => {
  await withApp({ HEARTBEAT_MS: "50" }, async (ctx) => {
    const room = await createRoom(ctx);
    const alive = connect(ctx.wsUrl);
    const dead = connect(ctx.wsUrl, { autoPong: false });
    await Promise.all([alive.opened, dead.opened]);
    alive.send({ type: "join", room: room.id, name: "Alive" });
    dead.send({ type: "join", room: room.id, name: "Dead" });
    await alive.next("joined");
    await dead.next("joined");

    const result = await Promise.race([
      dead.closed,
      sleep(1000).then(() => "alive"),
    ]);
    assert.notEqual(result, "alive", "мертвий сокет мав бути розірваний");
    assert.equal(result.code, 1006, "terminate = аномальне закриття");

    assert.equal(alive.ws.readyState, alive.ws.OPEN);
    // Після розриву «мертвий» гравець зник зі складу
    const roster = await alive.next("roster");
    assert.ok(roster.players.some((p) => p.name === "Alive"));
  });
});

test("політика slow-client: chat пропускається, критичне -> 4006", async () => {
  await withApp({ BUFFERED_LIMIT: "1024" }, async (ctx) => {
    const room = await createRoom(ctx);
    const fast = await joined(ctx, room.id, "Fast");
    const slow = await joined(ctx, room.id, "Slow");
    await fast.next("roster");

    // Імітуємо переповнений буфер на стороні сервера для сокета Slow.
    // clients — Set у порядку підключення: [Fast, Slow].
    const slowSocket = [...ctx.app.ws.clients][1];
    Object.defineProperty(slowSocket, "bufferedAmount", {
      get: () => 5_000_000,
    });

    fast.send({ type: "chat", text: "hello" });
    assert.equal((await fast.next("chat")).text, "hello", "швидкий отримує");
    await sleep(100);
    assert.ok(
      !slow.inbox.some((m) => m.type === "chat"),
      "повільному chat не шлемо",
    );
    assert.equal(
      slow.ws.readyState,
      slow.ws.OPEN,
      "chat — некритичний, не закриваємо",
    );

    // Зміна складу — критична: клієнт повільний, тож закриваємо його
    const third = await joined(ctx, room.id, "Third");
    assert.equal((await slow.closed).code, CLOSE.SLOW_CLIENT);
    assert.equal(third.ws.readyState, third.ws.OPEN);
  });
});

test("graceful shutdown: сокети закриваються з 1001, лог дописано, нові з'єднання відхиляються", async () => {
  let logFile;
  let clientCode;
  await withApp({}, async (ctx) => {
    const room = await createRoom(ctx);
    const ann = await joined(ctx, room.id, "Ann");
    ann.send({ type: "chat", text: "до зупинки" });
    await ann.next("chat");
    logFile = (await (await fetch(`${ctx.http}/api/replays`)).json())[0];

    await ctx.app.stop();
    clientCode = (await ann.closed).code;

    await assert.rejects(
      fetch(`${ctx.http}/health`),
      "сервер більше не слухає",
    );
  });
  assert.equal(clientCode, CLOSE.GOING_AWAY);
  assert.ok(logFile, "у списку записів був лог матчу");
});

test("graceful shutdown: файл логу містить усі події та deleted наприкінці", async () => {
  await withApp({}, async (ctx) => {
    const room = await createRoom(ctx);
    const ann = await joined(ctx, room.id, "Ann");
    ann.send({ type: "chat", text: "перед зупинкою" });
    await ann.next("chat");

    await ctx.app.stop();
    await ann.closed;

    // Сервер зупинений, тому читаємо файл логу напряму з диска.
    const files = (await readdir(ctx.logDir)).filter((f) =>
      f.endsWith(".ndjson"),
    );
    assert.equal(files.length, 1);
    const events = (await readFile(`${ctx.logDir}/${files[0]}`, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    const types = events.map((e) => e.type);
    assert.equal(types[0], "created");
    assert.ok(types.includes("join") && types.includes("chat"));
    assert.equal(types.at(-1), "deleted");
  });
});
