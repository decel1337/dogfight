import { BULLET, DT } from "../constants.ts";
import type { EntityId, Arena } from "../types.ts";
import { SHIP_FLAGS } from "../sim/entities.ts";
import type { EntityRecord } from "../sim/entity.ts";
import {
  type Controls,
  type Integrate,
  integrate as sharedIntegrate,
  muzzle,
  type ShipState,
} from "../sim/integrate.ts";
import { lerpAngle } from "../sim/vector.ts";
import { lerpWrap, shortestDelta, wrapInto } from "./geometry.ts";

// Стан корабля на клієнті: те, що приймає integrate, плюс прапорці вигляду.
export interface PredictedState extends ShipState {
  readonly thrusting: boolean;
  readonly dead: boolean;
}

// Input, ще не підтверджений сервером.
export interface PendingInput extends Controls {
  readonly seq: number;
}

// Передбачена локальна куля.
export interface PredictedBullet {
  seq: number;
  tag: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  ttl: number;
  serverId: EntityId | null; // заповниться, коли снапшот підтвердить кулю
}

export interface RenderState {
  readonly x: number;
  readonly y: number;
  readonly angle: number;
  readonly thrusting: boolean;
}

// Стан корабля з запису снапшота.
export function stateFromRecord(rec: EntityRecord): PredictedState {
  const dead = (rec.flags & SHIP_FLAGS.dead) !== 0;
  return {
    x: rec.x,
    y: rec.y,
    vx: rec.vx,
    vy: rec.vy,
    angle: rec.angle,
    cooldown: dead ? 0 : rec.b,
    rapid: (rec.flags & SHIP_FLAGS.rapid) !== 0,
    thrusting: (rec.flags & SHIP_FLAGS.thrusting) !== 0,
    dead,
  };
}

// Передбачення власного корабля + реконсиляція із сервером.
//
//  step(input)        — застосувати input ОДРАЗУ тим самим integrate, що й сервер
//  reconcile(rec,ack) — прийшов снапшот: взяти стан сервера, відкинути
//                       підтверджені input, перевідтворити решту
//  renderState(alpha) — стан для малювання (між кроками + згладжена поправка)
//
// integrate можна підмінити (так перевіряється експеримент з Math.random()).
export class Predictor {
  readonly arena: Arena;
  readonly integrate: Integrate;
  readonly snapDistance: number;
  readonly smoothingMs: number;

  state: PredictedState | null = null;
  prev: PredictedState | null = null;
  pending: PendingInput[] = []; // input, ще не підтверджені сервером
  nextSeq = 1;
  offset = { x: 0, y: 0 }; // видима поправка, що затухає
  bullets: PredictedBullet[] = []; // передбачені локальні кулі
  lastCorrection = 0;

  constructor({
    arena,
    integrate = sharedIntegrate,
    snapDistance = 80,
    smoothingMs = 100,
  }: {
    arena: Arena;
    integrate?: Integrate;
    snapDistance?: number;
    smoothingMs?: number;
  }) {
    this.arena = arena;
    this.integrate = integrate;
    this.snapDistance = snapDistance;
    this.smoothingMs = smoothingMs;
  }

  get ready(): boolean {
    return this.state !== null;
  }

  get alive(): boolean {
    return this.state !== null && !this.state.dead;
  }

  // Крок симуляції клієнта: створює input з наступним seq. Повертає його
  // (його треба надіслати) разом із передбаченою кулею.
  step(controls: Controls): { input: PendingInput; bullet: PredictedBullet | null } {
    const input: PendingInput = { ...controls, seq: this.nextSeq++ };
    this.pending.push(input);
    if (this.pending.length > 120) this.pending.shift();

    this.#advanceBullets();
    const current = this.state;
    if (!current || current.dead) return { input, bullet: null };

    this.prev = current;
    const next = this.integrate(current, input, DT, this.arena);
    this.state = { ...next, dead: false };

    let bullet: PredictedBullet | null = null;
    if (next.fired === 1) {
      // Самонавідну (fired === 2) передбачити не можемо: ціль знає сервер.
      const m = muzzle(next, false);
      bullet = {
        seq: input.seq,
        tag: input.seq & 0xff,
        x: m.x,
        y: m.y,
        vx: m.vx,
        vy: m.vy,
        angle: m.angle,
        ttl: BULLET.ttlTicks,
        serverId: null,
      };
      this.bullets.push(bullet);
    }
    return { input, bullet };
  }

  #advanceBullets(): void {
    const { width, height } = this.arena;
    for (const b of this.bullets) {
      b.ttl--;
      b.x = wrapInto(b.x + b.vx * DT, width);
      b.y = wrapInto(b.y + b.vy * DT, height);
    }
    this.bullets = this.bullets.filter((b) => b.ttl > 0);
  }

  // Снапшот сервера: rec — запис НАШОГО корабля, ack — останній обработаний
  // сервером seq нашого клієнта. Повертає розмір поправки в px.
  reconcile(rec: EntityRecord, ack: number): number {
    for (let head = this.pending[0]; head && head.seq <= ack; head = this.pending[0]) {
      this.pending.shift();
    }

    const before = this.state;
    let state: PredictedState = stateFromRecord(rec);
    let prev: PredictedState = state;

    if (!state.dead) {
      for (const input of this.pending) {
        prev = state;
        state = {
          ...this.integrate(state, input, DT, this.arena),
          dead: false,
        };
      }
    }

    let magnitude = 0;
    if (before && !before.dead && !state.dead) {
      const dx = shortestDelta(before.x - state.x, this.arena.width);
      const dy = shortestDelta(before.y - state.y, this.arena.height);
      magnitude = Math.sqrt(dx * dx + dy * dy);
      if (magnitude > this.snapDistance) {
        this.offset = { x: 0, y: 0 }; // великий розрив — не згладжуємо
      } else {
        this.offset = { x: this.offset.x + dx, y: this.offset.y + dy };
      }
      this.prev = prev;
    } else {
      this.offset = { x: 0, y: 0 }; // смерть або респавн
      this.prev = state;
    }

    this.state = state;
    this.lastCorrection = magnitude;
    return magnitude;
  }

  // Звіряє передбачені кулі з кулями сервера. ownerId — id нашого корабля.
  // Повертає множину id серверних куль, які малювати НЕ треба (їх уже
  // показує локальна копія).
  syncBullets(
    entities: readonly EntityRecord[],
    ack: number,
    ownerId: EntityId,
  ): Set<EntityId> {
    const mine = new Map<EntityId, EntityRecord>();
    for (const e of entities) {
      if (e.kind === 2 && e.c === ownerId) mine.set(e.id, e);
    }

    const claimed = new Set<EntityId>();
    for (const b of this.bullets) {
      if (b.serverId === null) {
        for (const [id, e] of mine) {
          if (e.b === b.tag && !claimed.has(id) && !this.#isClaimed(id)) {
            b.serverId = id;
            break;
          }
        }
      }
    }

    this.bullets = this.bullets.filter((b) => {
      if (b.serverId !== null) return mine.has(b.serverId); // ще існує на сервері
      return b.seq > ack; // не підтверджена: чекаємо, поки сервер її обробить
    });

    for (const b of this.bullets) {
      if (b.serverId !== null) claimed.add(b.serverId);
    }
    return claimed;
  }

  #isClaimed(id: EntityId): boolean {
    return this.bullets.some((b) => b.serverId === id);
  }

  // Згладжування поправки: за smoothingMs залишається ≈5%.
  decay(seconds: number): void {
    const tau = this.smoothingMs / 3 / 1000;
    const k = Math.exp(-seconds / tau);
    this.offset = { x: this.offset.x * k, y: this.offset.y * k };
  }

  renderState(alpha: number): RenderState | null {
    if (!this.state || this.state.dead) return null;
    const { width, height } = this.arena;
    const from = this.prev ?? this.state;
    const to = this.state;
    return {
      x: wrapInto(lerpWrap(from.x, to.x, alpha, width) + this.offset.x, width),
      y: wrapInto(lerpWrap(from.y, to.y, alpha, height) + this.offset.y, height),
      angle: lerpAngle(from.angle, to.angle, alpha),
      thrusting: to.thrusting,
    };
  }
}
