import { encodeInput, encodePing } from "@dogfight/shared/codec";
import { DT, TICK_MS } from "@dogfight/shared/constants";
import {
  Predictor,
  ServerClock,
  SnapshotBuffer,
} from "@dogfight/shared/netcode";
import { integrate as sharedIntegrate } from "@dogfight/shared/sim";

const SOUND_BY_EVENT = { 1: "fire", 2: "hit", 3: "explode" };
const HISTORY = 120;
const EXPLOSION_SECONDS = 0.6;

// Експеримент «integrate з Math.random()»: клієнт рахує трохи інакше, ніж
// сервер, і кожен снапшот «поправляє» його. Лише для демонстрації (?brokenIntegrate=1).
export function brokenIntegrate(state, input, dt, arena) {
  const next = sharedIntegrate(state, input, dt, arena);
  return { ...next, x: next.x + (Math.random() - 0.5) * 0.8 };
}

const push = (list, value) => {
  list.push(value);
  if (list.length > HISTORY) list.shift();
};

// Увесь мережевий стан гри на клієнті, без DOM і без сокета: байти йдуть
// через `send`, час береться з `now`. Тому його перевіряють тести в Node.
//
//   step(controls)       — крок симуляції клієнта (30 Гц): передбачити + надіслати
//   onSnapshot / onEvents / onPong — повідомлення сервера
//   scene(alpha)         — що малювати цього кадру
export class NetGame {
  constructor({
    joined,
    send,
    now = () => performance.now(),
    play = () => {},
    options = {},
  }) {
    this.shipId = joined.ship;
    this.arena = joined.arena;
    this.codec = joined.codec;
    this.sendRaw = send;
    this.now = now;
    this.play = play;

    this.options = {
      predict: true,
      interpolationDelayTicks: 2,
      broken: false,
      ...options,
    };

    this.predictor = new Predictor({
      arena: this.arena,
      integrate: this.options.broken ? brokenIntegrate : sharedIntegrate,
    });
    this.buffer = new SnapshotBuffer();
    this.clock = new ServerClock();

    this.ownRecord = null; // останній запис нашого корабля від сервера
    this.claimed = new Set(); // серверні кулі, замінені локальними копіями
    this.effects = [];
    this.pendingEvents = [];
    this.renderTick = 0;
    this.mode = "empty";

    // --- статистика для netgraph ---
    this.rttMs = 0;
    this.rttSamples = [];
    this.arrivals = []; // інтервали між снапшотами, мс
    this.corrections = []; // розмір поправки на кожен снапшот, px
    this.gaps = []; // різниця тиків між сусідніми снапшотами
    this.snapshots = 0;
    this.lastArrival = null;
    this.lastTick = -1;
    this.lastAckGap = 0;
    this.stepsSent = 0;
  }

  get ready() {
    return this.ownRecord !== null || this.buffer.latest !== null;
  }

  get interpolationDelayMs() {
    return this.options.interpolationDelayTicks * TICK_MS;
  }

  // ---------- вихідні повідомлення ----------

  #estimatedTick() {
    return this.clock.ready
      ? Math.max(0, Math.round(this.clock.serverTickAt(this.now())))
      : 0;
  }

  // Один крок симуляції клієнта: тим самим integrate, що й сервер,
  // застосовуємо input ОДРАЗУ (передбачення) і відправляємо його серверу.
  step(controls) {
    const { input, bullet } = this.options.predict
      ? this.predictor.step(controls)
      : this.#unpredictedStep(controls);
    if (bullet) this.play("fire");

    const message = { type: "input", ...input, tick: this.#estimatedTick() };
    this.sendRaw(this.codec === "binary" ? encodeInput(message) : message);
    this.stepsSent++;
  }

  // Режим ?predict=0: input лише відправляємо, а свій корабель малюємо за
  // снапшотами сервера, як чужий (видно повну затримку).
  #unpredictedStep(controls) {
    const input = { ...controls, seq: this.predictor.nextSeq++ };
    return { input, bullet: null };
  }

  ping() {
    const t = Math.round(this.now()) >>> 0;
    this.sendRaw(
      this.codec === "binary" ? encodePing({ t }) : { type: "ping", t },
    );
  }

  // ---------- вхідні повідомлення ----------

  onPong(msg) {
    const rtt = (Math.round(this.now()) >>> 0) - msg.t;
    if (rtt < 0 || rtt > 10_000) return;
    this.rttMs = this.rttMs === 0 ? rtt : this.rttMs * 0.8 + rtt * 0.2;
    push(this.rttSamples, rtt);
  }

  onSnapshot(msg) {
    const at = this.now();
    if (!this.buffer.push(msg, at)) return; // дублікат
    this.snapshots++;

    if (this.lastArrival !== null) push(this.arrivals, at - this.lastArrival);
    this.lastArrival = at;

    // Лише новіший за всі попередні снапшот оновлює годинник і стан.
    // Перевпорядкований (старий) потрапляє в буфер, але не «відкочує» нас.
    if (msg.tick < this.lastTick) return;
    if (this.lastTick >= 0) push(this.gaps, msg.tick - this.lastTick);
    this.lastTick = msg.tick;
    this.clock.observe(msg.tick, at);

    const own = msg.entities.find((e) => e.id === this.shipId && e.kind === 1);
    if (own) {
      this.ownRecord = own;
      if (this.options.predict) {
        const correction = this.predictor.reconcile(own, msg.ack);
        push(this.corrections, correction);
        this.claimed = this.predictor.syncBullets(
          msg.entities,
          msg.ack,
          this.shipId,
        );
      }
    }
    if (!this.options.predict) push(this.corrections, 0);
    this.lastAckGap = this.predictor.nextSeq - 1 - msg.ack;
  }

  onEvents(msg) {
    for (const event of msg.events)
      this.pendingEvents.push({ tick: msg.tick, ...event });
  }

  // Події сервера відтворюємо, коли час рендеру дійшов до їхнього тику:
  // інакше вибух з'являвся б раніше за кулю, що його спричинила (інші
  // сутності малюються в минулому).
  #releaseEvents() {
    const rest = [];
    for (const e of this.pendingEvents) {
      if (e.tick > this.renderTick) {
        rest.push(e);
        continue;
      }
      // Свій постріл при передбаченні вже зіграно локально.
      const mine = e.kind === 1 && e.id === this.shipId && this.options.predict;
      if (!mine) this.play(SOUND_BY_EVENT[e.kind]);
      if (e.kind === 3) this.#explode(e.x, e.y);
      else if (e.kind === 2)
        this.effects.push({ type: "spark", x: e.x, y: e.y, age: 0 });
    }
    this.pendingEvents = rest;
  }

  #explode(x, y) {
    const particles = [];
    for (let i = 0; i < 16; i++) {
      // Візуальний ефект: тут можна Math.random(), це не симуляція.
      particles.push({
        angle: Math.random() * Math.PI * 2,
        speed: 40 + Math.random() * 120,
      });
    }
    this.effects.push({ type: "explosion", x, y, age: 0, particles });
  }

  // ---------- малювання ----------

  scene(alpha, frameSeconds = 0) {
    const now = this.now();
    this.renderTick = this.clock.ready
      ? this.clock.serverTickAt(now) - this.options.interpolationDelayTicks
      : 0;

    const sample = this.buffer.sample(this.renderTick, this.arena);
    this.mode = sample.mode;
    this.#releaseEvents();
    for (const effect of this.effects) effect.age += frameSeconds;
    this.effects = this.effects.filter((e) => e.age < EXPLOSION_SECONDS);

    const predicting = this.options.predict && this.predictor.ready;
    const entities = [];
    for (const e of sample.entities) {
      if (predicting && e.id === this.shipId) continue; // себе малюємо з передбачення
      if (predicting && this.claimed.has(e.id)) continue; // кулю показує її локальна копія
      entities.push(e);
    }

    let me = null;
    const own = this.ownRecord;
    if (predicting) {
      const view = this.predictor.renderState(alpha);
      if (view && own)
        me = { ...own, ...view, id: this.shipId, predicted: true };
      else if (own) me = { ...own, predicted: true }; // мертвий
    } else if (own) {
      const interpolated = sample.entities.find((e) => e.id === this.shipId);
      me = { ...(interpolated ?? own), predicted: false };
      me.a = own.a;
      me.c = own.c;
    }

    const bullets = predicting
      ? this.predictor.bullets.map((b) => ({
          x: b.x + b.vx * DT * alpha,
          y: b.y + b.vy * DT * alpha,
          angle: b.angle,
        }))
      : [];

    return {
      arena: this.arena,
      entities: me ? entities.filter((e) => e.id !== me.id) : entities,
      me,
      localBullets: bullets,
      effects: this.effects,
    };
  }

  // ---------- для netgraph ----------

  netStats() {
    const mean = (xs) =>
      xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
    const rttMean = mean(this.rttSamples);
    const jitter = mean(this.rttSamples.map((r) => Math.abs(r - rttMean)));
    const arrivalMean = mean(this.arrivals);
    const spanTicks = this.gaps.reduce((a, b) => a + b, 0);
    const lost = spanTicks - this.gaps.length;
    return {
      rttMs: this.rttMs,
      jitterMs: jitter,
      snapshotHz: arrivalMean > 0 ? 1000 / arrivalMean : 0,
      lossPct: spanTicks > 0 ? (lost / spanTicks) * 100 : 0,
      mode: this.mode,
      pendingInputs: this.predictor.pending.length,
      unackedInputs: this.lastAckGap,
      correctionPx: this.corrections.at(-1) ?? 0,
      correctionMaxPx: Math.max(0, ...this.corrections),
      interpolationDelayMs: this.interpolationDelayMs,
      bufferSnapshots: this.buffer.snaps.length,
      aheadTicks:
        this.clock.ready && this.buffer.latest
          ? this.clock.serverTickAt(this.now()) - this.buffer.latest.tick
          : 0,
      arrivals: this.arrivals,
      corrections: this.corrections,
      predict: this.options.predict,
      codec: this.codec,
    };
  }

  setOption(name, value) {
    this.options[name] = value;
    if (name === "predict" && value) {
      // Увімкнули передбачення на льоту: стартуємо зі стану сервера.
      this.predictor.state = null;
      this.predictor.pending = [];
      if (this.ownRecord)
        this.predictor.reconcile(this.ownRecord, this.predictor.nextSeq - 1);
    }
  }
}
