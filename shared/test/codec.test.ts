import assert from "node:assert/strict";
import { test } from "vitest";
import {
  ANGLE_SCALE,
  CodecError,
  EVENT_SIZE,
  EVENTS_HEADER,
  FORMAT_VERSION,
  INPUT_SIZE,
  MSG,
  RECORD_SIZE,
  SNAPSHOT_HEADER,
  decodeBinary,
  encodeBinary,
  getCodec,
  parseClientBinary,
} from "../src/codec/index.ts";
import { CLOSE, type GameEvent, type SnapshotMessage } from "../src/protocol/index.ts";
import type { EntityRecord } from "../src/sim/index.ts";
import { entityId } from "../src/types.ts";
import { expectMessage, expectRejected, runScenario } from "./helpers.ts";

const F32 = 2 ** -23; // відносна точність float32

const near = (a: number, b: number, rel = F32 * 2): boolean =>
  Math.abs(a - b) <= Math.max(Math.abs(b), 1) * rel;

function sampleSnapshot(): SnapshotMessage {
  const snap = runScenario(150).snapshot();
  return { type: "snapshot", tick: snap.tick, ack: 4_000_000_000, entities: [...snap.entities] };
}

test("розкладка: розміри збігаються зі специфікацією", () => {
  assert.equal(RECORD_SIZE, 26);
  assert.equal(INPUT_SIZE, 10);
  assert.equal(encodeBinary({ type: "ping", t: 1 }).length, 5);
  assert.equal(encodeBinary({ type: "pong", t: 1, tick: 2 }).length, 9);
  const snap = sampleSnapshot();
  assert.equal(
    encodeBinary(snap).length,
    SNAPSHOT_HEADER + snap.entities.length * RECORD_SIZE,
  );
  assert.equal(
    encodeBinary({ type: "events", tick: 1, events: [{ kind: 1, id: entityId(2), x: 3, y: 4 }] }).length,
    EVENTS_HEADER + EVENT_SIZE,
  );
});

test("розкладка: байт 0 = версія|тип, байти 1–4 = tick (little-endian)", () => {
  const bytes = encodeBinary({ type: "snapshot", tick: 0x01020304, ack: 0, entities: [] });
  assert.equal(bytes[0], (FORMAT_VERSION << 4) | MSG.SNAPSHOT);
  assert.deepEqual([...bytes.slice(1, 5)], [0x04, 0x03, 0x02, 0x01], "молодший байт першим");
});

test("round trip: snapshot (у межах квантування)", () => {
  const original = sampleSnapshot();
  const back = expectMessage(decodeBinary(encodeBinary(original)), "snapshot");
  assert.equal(back.tick, original.tick);
  assert.equal(back.ack, original.ack);
  assert.equal(back.entities.length, original.entities.length);

  original.entities.forEach((e, i) => {
    const d = back.entities[i];
    assert.ok(d);
    assert.equal(d.id, e.id);
    assert.equal(d.kind, e.kind);
    assert.equal(d.flags, e.flags);
    assert.ok(near(d.x, e.x) && near(d.y, e.y), `позиція ${i}`);
    assert.ok(near(d.vx, e.vx) && near(d.vy, e.vy), `швидкість ${i}`);
    assert.ok(Math.abs(d.angle - e.angle) <= 0.5 / ANGLE_SCALE + 1e-12, `кут ${i}`);
    assert.equal(d.a, e.a);
    assert.equal(d.b, e.b);
    assert.equal(d.c, e.c);
  });
});

test("round trip: кут по всьому діапазону [-π, π] у межах 0.0005 рад", () => {
  for (let k = -3142; k <= 3142; k += 7) {
    const angle = (k / 1000) * 0.9999 + 0.00013;
    const e: EntityRecord = { id: entityId(1), kind: 1, flags: 0, x: 0, y: 0, vx: 0, vy: 0, angle, a: 0, b: 0, c: 0 };
    const out = expectMessage(decodeBinary(encodeBinary({ type: "snapshot", tick: 0, ack: 0, entities: [e] })), "snapshot");
    assert.ok(Math.abs((out.entities[0]?.angle ?? NaN) - angle) <= 0.0005 + 1e-9, `angle ${angle}`);
  }
});

test("round trip: input, ping, pong, events", () => {
  for (const turn of [-1, 0, 1] as const) {
    for (const fire of [0, 1, 2] as const) {
      for (const thrust of [0, 1] as const) {
        const input = { type: "input", tick: 4_294_967_295, seq: 123456, thrust, turn, fire } as const;
        const back = decodeBinary(encodeBinary(input));
        assert.deepEqual(back, input);
      }
    }
  }
  assert.deepEqual(decodeBinary(encodeBinary({ type: "ping", t: 777 })), { type: "ping", t: 777 });
  assert.deepEqual(decodeBinary(encodeBinary({ type: "pong", t: 5, tick: 9 })), {
    type: "pong",
    t: 5,
    tick: 9,
  });
  const events: GameEvent[] = [
    { kind: 1, id: entityId(7), x: 10.5, y: 20.25 },
    { kind: 3, id: entityId(65535), x: 0, y: 799.5 },
  ];
  const back = expectMessage(decodeBinary(encodeBinary({ type: "events", tick: 12, events })), "events");
  assert.deepEqual(back.events, events);
});

test("декодер відхиляє чужу версію, обрізані й суперечливі кадри", () => {
  const good = encodeBinary(sampleSnapshot());

  const wrongVersion = good.slice();
  wrongVersion[0] = (2 << 4) | MSG.SNAPSHOT;
  assert.throws(() => decodeBinary(wrongVersion), CodecError);

  assert.throws(() => decodeBinary(good.slice(0, good.length - 1)), CodecError);
  assert.throws(() => decodeBinary(good.slice(0, 3)), CodecError);

  const unknownType = good.slice();
  unknownType[0] = (FORMAT_VERSION << 4) | 15;
  assert.throws(() => decodeBinary(unknownType), CodecError);

  const lying = good.slice();
  new DataView(lying.buffer).setUint16(9, 60000, true); // N не відповідає довжині
  assert.throws(() => decodeBinary(lying), CodecError);
});

test("parseClientBinary: коректний input проходить, підробка — ні", () => {
  const ok = parseClientBinary(
    encodeBinary({ type: "input", tick: 1, seq: 2, thrust: 1, turn: -1, fire: 2 }),
    { maxBytes: 64 },
  );
  assert.deepEqual(ok, {
    ok: true,
    msg: { type: "input", tick: 1, seq: 2, thrust: 1, turn: -1, fire: 2 },
  });

  const forged = encodeBinary({ type: "input", tick: 1, seq: 2, thrust: 0, turn: 0, fire: 0 });
  forged[9] = 0b0000_0110; // turn+1 = 3  =>  turn = 2: чит
  assert.equal(expectRejected(parseClientBinary(forged, { maxBytes: 64 })).code, CLOSE.INVALID_MESSAGE);

  forged[9] = 0b1110_0000; // зарезервовані біти
  assert.equal(parseClientBinary(forged, { maxBytes: 64 }).ok, false);

  forged[9] = 0b0001_1000; // fire = 3
  assert.equal(parseClientBinary(forged, { maxBytes: 64 }).ok, false);

  const big = parseClientBinary(new Uint8Array(100), { maxBytes: 64 });
  assert.equal(expectRejected(big).code, CLOSE.TOO_BIG);

  const snapshotFromClient = parseClientBinary(encodeBinary(sampleSnapshot()), { maxBytes: 4096 });
  assert.equal(snapshotFromClient.ok, false, "клієнт не може слати снапшоти");
});

test("json-кодек дає ті самі повідомлення, що й бінарний (у межах округлення)", () => {
  const json = getCodec("json");
  const bin = getCodec("binary");
  const snap = sampleSnapshot();
  const viaJson = expectMessage(json.decode(json.encode(snap)), "snapshot");
  const viaBin = expectMessage(bin.decode(bin.encode(snap)), "snapshot");
  assert.equal(viaJson.tick, viaBin.tick);
  assert.equal(viaJson.entities.length, viaBin.entities.length);
  viaJson.entities.forEach((e, i) => {
    const d = viaBin.entities[i];
    assert.ok(d);
    assert.ok(Math.abs(e.x - d.x) < 0.01 && Math.abs(e.y - d.y) < 0.01);
    assert.ok(Math.abs(e.angle - d.angle) < 0.001);
  });
  assert.equal(typeof json.encode(snap), "string");
  assert.ok(bin.encode(snap) instanceof Uint8Array);
});

test("бінарний кадр суттєво менший за JSON", () => {
  const snap = sampleSnapshot();
  const jsonBytes = new TextEncoder().encode(String(getCodec("json").encode(snap))).length;
  const binBytes = getCodec("binary").encode(snap).length;
  assert.ok(binBytes * 3 < jsonBytes, `${binBytes} проти ${jsonBytes}`);
});
