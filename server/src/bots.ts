import type { InputMessage } from "@dogfight/shared/protocol";
import { mulberry32, type Rng } from "@dogfight/shared/prng";
import type { EntityRecord } from "@dogfight/shared/sim";
import { type PlayerId, playerId } from "@dogfight/shared/types";
import type { Match, MatchFrame } from "./match.ts";

// Боти — це «гравці без сокета». Вони НЕ чіпають світ напряму: щотику дивляться
// на ТОЙ САМИЙ снапшот, що й людина, і шлють input через ТОЙ САМИЙ
// match.receiveInput (з seq, чергою, бюджетом кроків і валідацією).
// Тому навантаження від ботів чесне: сервер не відрізняє їх від людей.

export const BOT_ID_BASE = 60_000; // PlayerId u16: люди — з 1, боти — з 60000
export const MAX_BOTS = 400;

const TAU = Math.PI * 2;
const norm = (a: number): number => {
  const r = a % TAU;
  return r > Math.PI ? r - TAU : r < -Math.PI ? r + TAU : r;
};

export class Bot {
  readonly id: PlayerId;
  readonly #match: Match;
  readonly #rng: Rng;
  #seq = 0;
  #shipId = 0;
  #wander = 0; // «блукання»: випадковий зсув цілі, оновлюється рідко
  #wanderTicks = 0;

  readonly aggression: number;

  constructor(match: Match, id: PlayerId, seed: number, aggression = 1) {
    this.aggression = aggression;
    this.#match = match;
    this.id = id;
    this.#rng = mulberry32(seed);
    this.#shipId = match.addPlayer({ id }).id;
  }

  // Один «розум»: найближчий ворог (корабель/астероїд) -> повернутись -> стріляти.
  think(frame: MatchFrame): void {
    const entities = frame.snapshot.entities;
    let me: EntityRecord | undefined;
    for (const e of entities) {
      if (e.id === this.#shipId) {
        me = e;
        break;
      }
    }
    if (!me || (me.flags & 4) !== 0) return; // мертвий (DEAD) — чекаємо респавн

    let target: EntityRecord | undefined;
    let best = Number.POSITIVE_INFINITY;
    for (const e of entities) {
      if (e.id === me.id || (e.kind !== 1 && e.kind !== 3)) continue;
      if (e.kind === 1 && (e.flags & 4) !== 0) continue;
      const dx = e.x - me.x;
      const dy = e.y - me.y;
      const d = dx * dx + dy * dy;
      if (d < best) {
        best = d;
        target = e;
      }
    }

    if (--this.#wanderTicks <= 0) {
      this.#wander = (this.#rng() - 0.5) * 0.6;
      this.#wanderTicks = 10 + Math.floor(this.#rng() * 30);
    }

    let turn: -1 | 0 | 1 = 0;
    let fire: 0 | 1 | 2 = 0;
    let thrust: 0 | 1 = this.#rng() < 0.5 ? 1 : 0;
    if (target) {
      const want = Math.atan2(target.y - me.y, target.x - me.x) + this.#wander;
      const diff = norm(want - me.angle);
      turn = diff > 0.08 ? 1 : diff < -0.08 ? -1 : 0;
      // «Heavy shooting»: стріляємо майже завжди, коли ціль у конусі; кожен
      // 8-й постріл — самонавідний (fire: 2).
      if (Math.abs(diff) < 0.6 * this.aggression + 0.3) fire = this.#seq % 8 === 0 ? 2 : 1;
      if (best < 120 * 120) thrust = 0;
    }

    const input: InputMessage = {
      type: "input",
      seq: ++this.#seq,
      tick: frame.tick,
      thrust,
      turn,
      fire,
    };
    this.#match.receiveInput(this.id, input);
  }
}

// Набір ботів однієї гри; слухає той самий "frame", що й транспорт.
export class BotPool {
  readonly #bots = new Map<PlayerId, Bot>();
  readonly #match: Match;
  readonly #off: () => void;
  #next = 0;

  constructor(match: Match) {
    this.#match = match;
    const onFrame = (frame: MatchFrame): void => {
      for (const bot of this.#bots.values()) bot.think(frame);
    };
    match.on("frame", onFrame);
    this.#off = () => match.off("frame", onFrame);
  }

  get size(): number {
    return this.#bots.size;
  }

  add(count: number): number {
    let added = 0;
    while (added < count && this.#bots.size < MAX_BOTS) {
      const id = playerId(BOT_ID_BASE + this.#next);
      const bot = new Bot(this.#match, id, 0xb07 + this.#next * 7919);
      this.#next++;
      this.#bots.set(id, bot);
      added++;
    }
    if (added > 0 && !this.#match.ticker.running) this.#match.start();
    return added;
  }

  clear(): void {
    for (const id of this.#bots.keys()) this.#match.removePlayer(id);
    this.#bots.clear();
  }

  dispose(): void {
    this.#off();
    this.clear();
  }
}
