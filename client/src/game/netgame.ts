import { encodeInput, encodePing } from "@dogfight/shared/codec";
import { DT, TICK_MS } from "@dogfight/shared/constants";
import {
  type PredictedBullet,
  Predictor,
  SampleScratch,
  ServerClock,
  type SampleMode,
  SnapshotBuffer,
} from "@dogfight/shared/netcode";
import type {
  ClientGameMessage,
  CodecName,
  EventsMessage,
  GameEvent,
  JoinedMessage,
  PongMessage,
  SnapshotMessage,
} from "@dogfight/shared/protocol";
import {
  type Controls,
  type EntityRecord,
  type Integrate,
  integrate as sharedIntegrate,
} from "@dogfight/shared/sim";
import type { Arena, EntityId } from "@dogfight/shared/types";

const SOUND_BY_EVENT = { 1: "fire", 2: "hit", 3: "explode" } as const satisfies Record<
  GameEvent["kind"],
  string
>;

// Візуальні ефекти: union за `type`, тож draw розбирає його вичерпним switch.
export type Effect =
  | { type: "spark"; x: number; y: number; age: number }
  | {
      type: "explosion";
      x: number;
      y: number;
      age: number;
      particles: { angle: number; speed: number }[];
    };

// Наш корабель у сцені: запис сервера, можливо перекритий передбаченням.
export interface MeRecord extends EntityRecord {
  readonly predicted: boolean;
  readonly thrusting?: boolean | undefined;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export interface Scene {
  arena: Arena;
  entities: EntityRecord[];
  me: MeRecord | null;
  localBullets: { x: number; y: number; angle: number }[];
  effects: Effect[];
}

export interface NetOptions {
  predict: boolean;
  interpolationDelayTicks: number;
  broken: boolean;
}

export interface NetStats {
  rttMs: number;
  jitterMs: number;
  snapshotHz: number;
  lossPct: number;
  mode: SampleMode;
  pendingInputs: number;
  unackedInputs: number;
  correctionPx: number;
  correctionMaxPx: number;
  interpolationDelayMs: number;
  bufferSnapshots: number;
  aheadTicks: number;
  arrivals: number[];
  corrections: number[];
  predict: boolean;
  codec: CodecName;
}

// Те, що NetGame віддає в мережу: бінарний кадр або об'єкт для json-кодека.
export type OutgoingGame = Uint8Array<ArrayBuffer> | ClientGameMessage;

export interface NetGameOptions {
  joined: Pick<JoinedMessage, "ship" | "arena" | "codec">;
  send: (message: OutgoingGame) => void;
  now?: () => number;
  play?: (sound: string) => void;
  options?: Partial<NetOptions>;
}
const HISTORY = 120;
const EXPLOSION_SECONDS = 0.6;

// Експеримент «integrate з Math.random()»: клієнт рахує трохи інакше, ніж
// сервер, і кожен снапшот «поправляє» його. Лише для демонстрації (?brokenIntegrate=1).
export const brokenIntegrate: Integrate = (state, input, dt, arena) => {
  const next = sharedIntegrate(state, input, dt, arena);
  return { ...next, x: next.x + (Math.random() - 0.5) * 0.8 };
};

function copyRecord(to: Mutable<EntityRecord>, from: EntityRecord): void {
  to.id = from.id;
  to.kind = from.kind;
  to.flags = from.flags;
  to.x = from.x;
  to.y = from.y;
  to.vx = from.vx;
  to.vy = from.vy;
  to.angle = from.angle;
  to.a = from.a;
  to.b = from.b;
  to.c = from.c;
}

const push = (list: number[], value: number): void => {
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
  readonly shipId: EntityId;
  readonly arena: Arena;
  readonly codec: CodecName;
  readonly sendRaw: (message: OutgoingGame) => void;
  readonly now: () => number;
  readonly play: (sound: string) => void;
  readonly options: NetOptions;
  readonly predictor: Predictor;
  readonly buffer = new SnapshotBuffer();
  readonly clock = new ServerClock();

  // --- повторно використовувані об'єкти рендеру (M3: нуль алокацій на кадр) ---
  // Scene, що повертає scene(), — один і той самий об'єкт: вона дійсна до
  // НАСТУПНОГО виклику scene(). Хто хоче зберегти — копіює.
  readonly #scratch = new SampleScratch();
  readonly #view = { x: 0, y: 0, angle: 0, thrusting: false };
  readonly #me: Mutable<MeRecord> = {
    id: 0 as EntityId, kind: 1, flags: 0, x: 0, y: 0, vx: 0, vy: 0, angle: 0, a: 0, b: 0, c: 0,
    predicted: false, thrusting: undefined,
  };
  readonly #entities: EntityRecord[] = [];
  readonly #bulletPool: { x: number; y: number; angle: number }[] = [];
  readonly #localBullets: { x: number; y: number; angle: number }[] = [];
  readonly #scene: Scene;

  ownRecord: EntityRecord | null = null; // останній запис нашого корабля від сервера
  claimed = new Set<EntityId>(); // серверні кулі, замінені локальними копіями
  effects: Effect[] = [];
  pendingEvents: (GameEvent & { tick: number })[] = [];
  renderTick = 0;
  mode: SampleMode = "empty";

  // --- статистика для netgraph ---
  rttMs = 0;
  rttSamples: number[] = [];
  arrivals: number[] = []; // інтервали між снапшотами, мс
  corrections: number[] = []; // розмір поправки на кожен снапшот, px
  gaps: number[] = []; // різниця тиків між сусідніми снапшотами
  snapshots = 0;
  lastArrival: number | null = null;
  lastTick = -1;
  lastAckGap = 0;
  stepsSent = 0;

  constructor({ joined, send, now = () => performance.now(), play = () => {}, options = {} }: NetGameOptions) {
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
    this.#scene = {
      arena: this.arena,
      entities: this.#entities,
      me: null,
      localBullets: this.#localBullets,
      effects: this.effects,
    };
  }

  get ready(): boolean {
    return this.ownRecord !== null || this.buffer.latest !== null;
  }

  get interpolationDelayMs(): number {
    return this.options.interpolationDelayTicks * TICK_MS;
  }

  // ---------- вихідні повідомлення ----------

  #estimatedTick(): number {
    return this.clock.ready
      ? Math.max(0, Math.round(this.clock.serverTickAt(this.now())))
      : 0;
  }

  // Один крок симуляції клієнта: тим самим integrate, що й сервер,
  // застосовуємо input ОДРАЗУ (передбачення) і відправляємо його серверу.
  step(controls: Controls): void {
    const { input, bullet } = this.options.predict
      ? this.predictor.step(controls)
      : this.#unpredictedStep(controls);
    if (bullet) this.play("fire");

    const message = { type: "input" as const, ...input, tick: this.#estimatedTick() };
    this.sendRaw(this.codec === "binary" ? encodeInput(message) : message);
    this.stepsSent++;
  }

  // Режим ?predict=0: input лише відправляємо, а свій корабель малюємо за
  // снапшотами сервера, як чужий (видно повну затримку).
  #unpredictedStep(controls: Controls): { input: Controls & { seq: number }; bullet: PredictedBullet | null } {
    const input = { ...controls, seq: this.predictor.nextSeq++ };
    return { input, bullet: null };
  }

  ping(): void {
    const t = Math.round(this.now()) >>> 0;
    this.sendRaw(this.codec === "binary" ? encodePing({ t }) : { type: "ping" as const, t });
  }

  // ---------- вхідні повідомлення ----------

  onPong(msg: PongMessage): void {
    const rtt = (Math.round(this.now()) >>> 0) - msg.t;
    if (rtt < 0 || rtt > 10_000) return;
    this.rttMs = this.rttMs === 0 ? rtt : this.rttMs * 0.8 + rtt * 0.2;
    push(this.rttSamples, rtt);
  }

  onSnapshot(msg: SnapshotMessage): void {
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
        this.claimed = this.predictor.syncBullets(msg.entities, msg.ack, this.shipId);
      }
    }
    if (!this.options.predict) push(this.corrections, 0);
    this.lastAckGap = this.predictor.nextSeq - 1 - msg.ack;
  }

  onEvents(msg: EventsMessage): void {
    for (const event of msg.events) this.pendingEvents.push({ tick: msg.tick, ...event });
  }

  // Події сервера відтворюємо, коли час рендеру дійшов до їхнього тику:
  // інакше вибух з'являвся б раніше за кулю, що його спричинила (інші
  // сутності малюються в минулому).
  #releaseEvents(): void {
    const events = this.pendingEvents;
    let kept = 0;
    for (const e of events) {
      if (e.tick > this.renderTick) {
        events[kept++] = e; // ще рано: лишаємо в черзі (компактуємо на місці)
        continue;
      }
      // Свій постріл при передбаченні вже зіграно локально.
      const mine = e.kind === 1 && e.id === this.shipId && this.options.predict;
      if (!mine) this.play(SOUND_BY_EVENT[e.kind]);
      if (e.kind === 3) this.#explode(e.x, e.y);
      else if (e.kind === 2) this.effects.push({ type: "spark", x: e.x, y: e.y, age: 0 });
    }
    events.length = kept;
  }

  #explode(x: number, y: number): void {
    const particles: { angle: number; speed: number }[] = [];
    for (let i = 0; i < 16; i++) {
      // Візуальний ефект: тут можна Math.random(), це не симуляція.
      particles.push({ angle: Math.random() * Math.PI * 2, speed: 40 + Math.random() * 120 });
    }
    this.effects.push({ type: "explosion", x, y, age: 0, particles });
  }

  // ---------- малювання ----------

  scene(alpha: number, frameSeconds = 0): Scene {
    const now = this.now();
    this.renderTick = this.clock.ready
      ? this.clock.serverTickAt(now) - this.options.interpolationDelayTicks
      : 0;

    this.mode = this.buffer.sampleInto(this.#scratch, this.renderTick, this.arena);
    const sampled = this.#scratch.entities;
    this.#releaseEvents();

    // Ефекти: старіють і компактуються на місці (без filter/нового масиву).
    const effects = this.effects;
    let kept = 0;
    for (const effect of effects) {
      effect.age += frameSeconds;
      if (effect.age < EXPLOSION_SECONDS) effects[kept++] = effect;
    }
    effects.length = kept;

    const predicting = this.options.predict && this.predictor.ready;
    const own = this.ownRecord;
    const me = this.#me;
    let hasMe = false;
    if (predicting) {
      if (own && this.predictor.renderStateInto(alpha, this.#view)) {
        copyRecord(me, own);
        me.x = this.#view.x;
        me.y = this.#view.y;
        me.angle = this.#view.angle;
        me.thrusting = this.#view.thrusting;
        me.id = this.shipId;
        me.predicted = true;
        hasMe = true;
      } else if (own) {
        copyRecord(me, own); // мертвий
        me.thrusting = undefined;
        me.predicted = true;
        hasMe = true;
      }
    } else if (own) {
      let interpolated: EntityRecord | undefined;
      for (const e of sampled) {
        if (e.id === this.shipId) {
          interpolated = e;
          break;
        }
      }
      copyRecord(me, interpolated ?? own);
      me.a = own.a;
      me.c = own.c;
      me.thrusting = undefined;
      me.predicted = false;
      hasMe = true;
    }

    // Чужі сутності: без себе (малюємо окремо) і без куль, замінених локальними копіями.
    const entities = this.#entities;
    entities.length = 0;
    for (const e of sampled) {
      if (hasMe && e.id === me.id) continue;
      if (predicting && (e.id === this.shipId || this.claimed.has(e.id))) continue;
      entities.push(e);
    }

    // Локальні кулі: пул об'єктів {x,y,angle}, довжина масиву підганяється.
    const local = this.#localBullets;
    local.length = 0;
    if (predicting) {
      const pool = this.#bulletPool;
      let n = 0;
      for (const b of this.predictor.bullets) {
        const out = (pool[n] ??= { x: 0, y: 0, angle: 0 });
        out.x = b.x + b.vx * DT * alpha;
        out.y = b.y + b.vy * DT * alpha;
        out.angle = b.angle;
        local.push(out);
        n++;
      }
    }

    const scene = this.#scene;
    scene.me = hasMe ? me : null;
    return scene;
  }

  // ---------- для netgraph ----------

  netStats(): NetStats {
    const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
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
      aheadTicks: this.clock.ready && this.buffer.latest
        ? this.clock.serverTickAt(this.now()) - this.buffer.latest.tick
        : 0,
      arrivals: this.arrivals,
      corrections: this.corrections,
      predict: this.options.predict,
      codec: this.codec,
    };
  }

  setOption<K extends keyof NetOptions>(name: K, value: NetOptions[K]): void {
    this.options[name] = value;
    if (name === "predict" && value) {
      // Увімкнули передбачення на льоту: стартуємо зі стану сервера.
      this.predictor.state = null;
      this.predictor.pending = [];
      if (this.ownRecord) this.predictor.reconcile(this.ownRecord, this.predictor.nextSeq - 1);
    }
  }
}
