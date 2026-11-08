import assert from "node:assert/strict";
import { test } from "vitest";
import { decodeBinary } from "@dogfight/shared/codec";
import { TICK_MS } from "@dogfight/shared/constants";
import type { SnapshotMessage } from "@dogfight/shared/protocol";
import { type EntityRecord } from "@dogfight/shared/sim";
import { entityId } from "@dogfight/shared/types";
import { type NetOptions, NetGame, type OutgoingGame } from "../src/game/netgame.ts";

const ARENA = { width: 1200, height: 800 };
type RecInit = Partial<Omit<EntityRecord, "id" | "kind">> & { id?: number; kind?: EntityRecord["kind"] };
const rec = ({ id = 1, ...o }: RecInit = {}): EntityRecord => ({
  id: entityId(id), kind: 1, flags: 0, x: 600, y: 400, vx: 0, vy: 0, angle: 0, a: 3, b: 0, c: 0, ...o,
});
const snap = (tick: number, ack: number, entities: EntityRecord[]): SnapshotMessage => ({
  type: "snapshot", tick, ack, entities,
});

function make(options: Partial<NetOptions> = {}, codec: "binary" | "json" = "binary") {
  const clock = { t: 1000 };
  const sent: OutgoingGame[] = [];
  const sounds: string[] = [];
  const game = new NetGame({
    joined: { ship: entityId(1), arena: ARENA, codec },
    send: (m) => sent.push(m),
    now: () => clock.t,
    play: (n) => sounds.push(n),
    options,
  });
  return { game, clock, sent, sounds };
}

const idle = { thrust: 0, turn: 0, fire: 0 } as const;

test("step: бінарний input із зростаючим seq, 10 байт", () => {
  const { game, sent } = make();
  game.onSnapshot(snap(1, 0, [rec()]));
  game.step({ ...idle, thrust: 1 });
  game.step({ ...idle, thrust: 1 });
  assert.equal(sent.length, 2);
  const [first] = sent;
  assert.ok(first instanceof Uint8Array);
  assert.equal(first.byteLength, 10);
  assert.deepEqual(
    sent.map((b) => {
      assert.ok(b instanceof Uint8Array);
      const msg = decodeBinary(b);
      assert.equal(msg.type, "input");
      return msg.type === "input" ? msg.seq : -1;
    }),
    [1, 2],
  );
});

test("json-кодек: input відправляється об'єктом", () => {
  const { game, sent } = make({}, "json");
  game.onSnapshot(snap(1, 0, [rec()]));
  game.step(idle);
  const [first] = sent;
  assert.ok(first && !(first instanceof Uint8Array) && first.type === "input");
  assert.equal(first.seq, 1);
});

test("передбачення: корабель рухається одразу, без очікування сервера", () => {
  const { game } = make();
  game.onSnapshot(snap(1, 0, [rec()]));
  const before = game.scene(1).me?.x ?? NaN;
  for (let i = 0; i < 10; i++) game.step({ ...idle, thrust: 1 });
  const after = game.scene(1).me?.x ?? NaN;
  assert.ok(after > before + 1, `${before} -> ${after}`);
});

test("predict=false: свій корабель рухається лише зі снапшотів", () => {
  const { game, clock } = make({ predict: false });
  game.onSnapshot(snap(1, 0, [rec()]));
  game.onSnapshot(snap(2, 0, [rec()]));
  clock.t += 200;
  const before = game.scene(1).me?.x ?? NaN;
  for (let i = 0; i < 10; i++) game.step({ ...idle, thrust: 1 });
  assert.equal(game.scene(1).me?.x, before);
});

test("своя сутність і своя куля не потрапляють у entities (малюється передбачення)", () => {
  const { game, clock } = make();
  const bullet = rec({ id: 9, kind: 2, x: 620, vx: 420, a: 0, b: 1, c: 1 });
  game.onSnapshot(snap(1, 0, [rec()]));
  game.step({ ...idle, fire: 1 }); // seq 1 -> тег 1
  game.onSnapshot(snap(2, 1, [rec(), bullet, rec({ id: 2, x: 100 })]));
  clock.t += 300;
  const scene = game.scene(0);
  assert.equal(scene.me?.id, 1);
  assert.ok(!scene.entities.some((e) => e.id === 1 || e.id === 9));
  assert.ok(scene.entities.some((e) => e.id === 2));
  assert.equal(scene.localBullets.length, 1);
});

test("дублікат снапшота ігнорується, старий не відкочує стан", () => {
  const { game } = make();
  game.onSnapshot(snap(5, 0, [rec({ x: 500 })]));
  game.onSnapshot(snap(5, 0, [rec({ x: 999 })]));
  assert.equal(game.ownRecord?.x, 500);
  game.onSnapshot(snap(3, 0, [rec({ x: 111 })]));
  assert.equal(game.ownRecord?.x, 500, "перевпорядкований снапшот не перезаписує");
  assert.equal(game.snapshots, 2);
});

test("події показуються, коли час рендеру дійшов до їхнього тику", () => {
  const { game, clock, sounds } = make({ predict: false });
  game.onSnapshot(snap(10, 0, [rec()]));
  game.onEvents({ type: "events", tick: 14, events: [{ kind: 3, id: entityId(7), x: 10, y: 10 }] });
  game.scene(0);
  assert.equal(sounds.length, 0, "ще рано");
  clock.t += 8 * TICK_MS;
  game.scene(0);
  assert.deepEqual(sounds, ["explode"]);
  assert.equal(game.effects.length, 1);
});

test("власний постріл при передбаченні не звучить вдруге з події сервера", () => {
  const { game, clock, sounds } = make();
  game.onSnapshot(snap(1, 0, [rec()]));
  game.step({ ...idle, fire: 1 });
  assert.deepEqual(sounds, ["fire"]);
  game.onEvents({ type: "events", tick: 2, events: [{ kind: 1, id: entityId(1), x: 0, y: 0 }] });
  clock.t += 500;
  game.scene(0);
  assert.deepEqual(sounds, ["fire"]);
});

test("pong дає RTT; netStats рахує джитер і втрати за прогалинами тиків", () => {
  const { game, clock } = make();
  clock.t = 5000;
  game.onPong({ type: "pong", tick: 1, t: 4900 });
  assert.equal(Math.round(game.rttMs), 100);

  for (const tick of [1, 2, 3, 5, 6, 9]) {
    clock.t += TICK_MS;
    game.onSnapshot(snap(tick, 0, [rec()]));
  }
  const stats = game.netStats();
  // пропущено тики 4, 7, 8: 3 із 8 тиків між першим і останнім
  assert.ok(Math.abs(stats.lossPct - (3 / 8) * 100) < 0.01, `${stats.lossPct}`);
});

test("перемикання predict на льоту не ламає сцену", () => {
  const { game } = make({ predict: false });
  game.onSnapshot(snap(1, 0, [rec()]));
  game.setOption("predict", true);
  game.step({ ...idle, thrust: 1 });
  assert.equal(game.scene(1).me?.predicted, true);
});
