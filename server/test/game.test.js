import assert from "node:assert/strict";
import test from "node:test";
import { encodeInput, encodePing } from "@dogfight/shared/codec";
import { connect, createRoom, sleep, withApp } from "./helpers.js";

async function join(ctx, roomId, name, codec) {
  const client = connect(ctx.wsUrl);
  await client.opened;
  client.send({
    type: "join",
    room: roomId,
    name,
    ...(codec ? { codec } : {}),
  });
  const joined = await client.next("joined");
  return { client, joined };
}

test("joined містить усе для старту клієнтської симуляції", async () => {
  await withApp({}, async (ctx) => {
    const room = await createRoom(ctx);
    const { joined } = await join(ctx, room.id, "Ann");
    assert.equal(joined.tickRate, 30);
    assert.equal(joined.codec, "binary");
    assert.ok(Number.isInteger(joined.ship) && joined.ship > 0);
    assert.ok(Number.isInteger(joined.seed));
    assert.deepEqual(joined.arena, room.arena);
  });
});

test("бінарний кодек: снапшоти ~30 Гц, ack зростає після input", async () => {
  await withApp({}, async (ctx) => {
    const room = await createRoom(ctx);
    const { client, joined } = await join(ctx, room.id, "Ann");
    const first = await client.next("snapshot");
    assert.ok(first.entities.some((e) => e.id === joined.ship && e.kind === 1));

    for (let seq = 1; seq <= 5; seq++) {
      client.ws.send(
        encodeInput({ seq, tick: first.tick, thrust: 1, turn: 0, fire: 0 }),
      );
      await sleep(34);
    }
    await sleep(100);
    const snaps = client.inbox.filter((m) => m.type === "snapshot");
    assert.equal(snaps.at(-1).ack, 5);
    assert.ok(snaps.length >= 5, `отримано ${snaps.length}`);
  });
});

test("json кодек: ті самі повідомлення текстом", async () => {
  await withApp({}, async (ctx) => {
    const room = await createRoom(ctx);
    const { client, joined } = await join(ctx, room.id, "Ann", "json");
    assert.equal(joined.codec, "json");
    client.send({
      type: "input",
      seq: 1,
      tick: 0,
      thrust: 1,
      turn: 0,
      fire: 0,
    });
    await sleep(120);
    const snap = await client.next("snapshot");
    assert.equal(snap.v, 1);
    assert.ok(snap.entities.length > 0);
    assert.equal(
      client.inbox.some((m) => m.type === "snapshot" && m.ack === 1),
      true,
    );
  });
});

test("ping -> pong з ехо часу й тиком сервера", async () => {
  await withApp({}, async (ctx) => {
    const room = await createRoom(ctx);
    const { client } = await join(ctx, room.id, "Ann");
    client.ws.send(encodePing({ t: 12345 }));
    const pong = await client.next("pong");
    assert.equal(pong.t, 12345);
    assert.ok(pong.tick >= 0);
  });
});

test("input-чит: turn=1000 у JSON закриває сокет з 4002", async () => {
  await withApp({}, async (ctx) => {
    const room = await createRoom(ctx);
    const { client } = await join(ctx, room.id, "Cheat", "json");
    client.send({
      type: "input",
      seq: 1,
      tick: 0,
      thrust: 1,
      turn: 1000,
      fire: 0,
    });
    assert.equal((await client.closed).code, 4002);
  });
});

test("потік input не з'їдає ліміт чату", async () => {
  await withApp({ RATE_PER_SEC: "1", RATE_BURST: "3" }, async (ctx) => {
    const room = await createRoom(ctx);
    const { client } = await join(ctx, room.id, "Pilot");
    for (let seq = 1; seq <= 60; seq++) {
      client.ws.send(
        encodeInput({ seq, tick: 0, thrust: 0, turn: 0, fire: 0 }),
      );
    }
    client.send({ type: "chat", text: "ще тут" });
    assert.equal((await client.next("chat")).text, "ще тут");
    assert.equal(client.ws.readyState, client.ws.OPEN);
  });
});

test("netsim: net {latency:300} затримує pong приблизно на RTT", async () => {
  await withApp({}, async (ctx) => {
    const room = await createRoom(ctx);
    const { client } = await join(ctx, room.id, "Lag");
    client.send({ type: "net", latency: 300, jitter: 0, drop: 0 });
    await sleep(20);
    const t0 = performance.now();
    client.ws.send(encodePing({ t: 1 }));
    await client.next("pong", 2000);
    const rtt = performance.now() - t0;
    assert.ok(rtt > 270 && rtt < 420, `rtt=${rtt | 0}`);
  });
});

test("ENABLE_NETSIM=0: повідомлення net відхиляється", async () => {
  await withApp({ ENABLE_NETSIM: "0" }, async (ctx) => {
    const room = await createRoom(ctx);
    const { client } = await join(ctx, room.id, "Ann");
    client.send({ type: "net", latency: 100, jitter: 0, drop: 0 });
    assert.equal((await client.closed).code, 4002);
  });
});

test("/api/stats показує тривалість тика й джитер", async () => {
  await withApp({}, async (ctx) => {
    const room = await createRoom(ctx);
    await join(ctx, room.id, "Ann");
    await sleep(400);
    const stats = await (await fetch(`${ctx.http}/api/stats`)).json();
    assert.equal(stats.tickRate, 30);
    const m = stats.matches[0];
    assert.equal(m.players, 1);
    assert.ok(m.ticker.workMs.avg < 5);
    assert.ok(m.ticker.samples > 5);
  });
});
