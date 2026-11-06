import { DT } from "../constants.js";
import { SHIP_FLAGS } from "../sim/entities.js";
import { BULLET } from "../constants.js";
import { integrate as sharedIntegrate, muzzle } from "../sim/integrate.js";
import { lerpAngle } from "../sim/vector.js";
import { lerpWrap, shortestDelta, wrapInto } from "./geometry.js";

// Стан корабля з запису снапшота.
export function stateFromRecord(rec) {
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
  constructor({
    arena,
    integrate = sharedIntegrate,
    snapDistance = 80,
    smoothingMs = 100,
  }) {
    this.arena = arena;
    this.integrate = integrate;
    this.snapDistance = snapDistance;
    this.smoothingMs = smoothingMs;

    this.state = null;
    this.prev = null;
    this.pending = []; // input, ще не підтверджені сервером
    this.nextSeq = 1;
    this.offset = { x: 0, y: 0 }; // видима поправка, що затухає
    this.bullets = []; // передбачені локальні кулі
    this.lastCorrection = 0;
  }

  get ready() {
    return this.state !== null;
  }

  get alive() {
    return this.state !== null && !this.state.dead;
  }

  // Крок симуляції клієнта: створює input з наступним seq. Повертає його
  // (його треба надіслати) разом із передбаченою кулею.
  step(controls) {
    const input = { ...controls, seq: this.nextSeq++ };
    this.pending.push(input);
    if (this.pending.length > 120) this.pending.shift();

    this.#advanceBullets();
    if (!this.alive) return { input, bullet: null };

    this.prev = this.state;
    const next = this.integrate(this.state, input, DT, this.arena);
    this.state = { ...next, dead: false };

    let bullet = null;
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
        serverId: null, // заповниться, коли снапшот підтвердить кулю
      };
      this.bullets.push(bullet);
    }
    return { input, bullet };
  }

  #advanceBullets() {
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
  reconcile(rec, ack) {
    while (this.pending.length > 0 && this.pending[0].seq <= ack) {
      this.pending.shift();
    }

    const before = this.state;
    let state = stateFromRecord(rec);
    let prev = state;

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
    const comparable = before && !before.dead && !state.dead;
    if (comparable) {
      const dx = shortestDelta(before.x - state.x, this.arena.width);
      const dy = shortestDelta(before.y - state.y, this.arena.height);
      magnitude = Math.sqrt(dx * dx + dy * dy);
      if (magnitude > this.snapDistance) {
        this.offset = { x: 0, y: 0 }; // великий розрив — не згладжуємо
      } else {
        this.offset = { x: this.offset.x + dx, y: this.offset.y + dy };
      }
    } else {
      this.offset = { x: 0, y: 0 }; // смерть або респавн
    }

    this.state = state;
    this.prev = comparable ? prev : state;
    this.lastCorrection = magnitude;
    return magnitude;
  }

  // Звіряє передбачені кулі з кулями сервера. ownerId — id нашого корабля.
  // Повертає множину id серверних куль, які малювати НЕ треба (їх уже
  // показує локальна копія).
  syncBullets(entities, ack, ownerId) {
    const mine = new Map();
    for (const e of entities) {
      if (e.kind === 2 && e.c === ownerId) mine.set(e.id, e);
    }

    const claimed = new Set();
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

  #isClaimed(id) {
    return this.bullets.some((b) => b.serverId === id);
  }

  // Згладжування поправки: за smoothingMs залишається ≈5%.
  decay(seconds) {
    const tau = this.smoothingMs / 3 / 1000;
    const k = Math.exp(-seconds / tau);
    this.offset = { x: this.offset.x * k, y: this.offset.y * k };
  }

  renderState(alpha) {
    if (!this.state || this.state.dead) return null;
    const { width, height } = this.arena;
    const from = this.prev ?? this.state;
    const to = this.state;
    return {
      x: wrapInto(lerpWrap(from.x, to.x, alpha, width) + this.offset.x, width),
      y: wrapInto(
        lerpWrap(from.y, to.y, alpha, height) + this.offset.y,
        height,
      ),
      angle: lerpAngle(from.angle, to.angle, alpha),
      thrusting: to.thrusting,
    };
  }
}
