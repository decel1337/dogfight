import { SHIP } from "../constants.ts";
import type { Arena } from "../types.ts";
import { cos, sin } from "./dmath.ts";
import { normalizeAngle } from "./vector.ts";

// Керування одного кроку: те, що гравець «натиснув».
export interface Controls {
  readonly thrust: 0 | 1;
  readonly turn: -1 | 0 | 1;
  readonly fire: 0 | 1 | 2; // 0 — ні, 1 — звичайна, 2 — самонавідна
}

// Стан корабля, який приймає й повертає integrate.
export interface ShipState {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly angle: number;
  readonly cooldown: number;
  readonly rapid: boolean;
}

export interface IntegrateResult extends ShipState {
  readonly thrusting: boolean;
  readonly fired: 0 | 1 | 2;
}

export interface Muzzle {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly angle: number;
}

// Сигнатура integrate — спільна для сервера й клієнта (і для підміни в тестах).
export type Integrate = (
  state: ShipState,
  input: Controls,
  dt: number,
  arena: Arena,
) => IntegrateResult;

const wrap = (value: number, size: number): number =>
  ((value % size) + size) % size;

// Чиста функція руху корабля: (стан, input, dt) -> новий стан. Саме її
// викликають і сервер (авторитетно), і клієнт (передбачення). Вона не змінює
// аргументів, не читає годинник і не викликає Math.random().
//
// state: { x, y, vx, vy, angle, cooldown, rapid }
// input: { thrust: 0|1, turn: -1|0|1, fire: 0|1|2 }  (2 = самонавідна)
export function integrate(
  state: ShipState,
  input: Controls,
  dt: number,
  arena: Arena,
): IntegrateResult {
  const angle = normalizeAngle(state.angle + input.turn * SHIP.turnRate * dt);

  let vx = state.vx;
  let vy = state.vy;
  const thrusting = input.thrust === 1;
  if (thrusting) {
    vx += cos(angle) * SHIP.thrust * dt;
    vy += sin(angle) * SHIP.thrust * dt;
  }

  // Опір: за фіксованого кроку множник — готова константа.
  const drag = SHIP.drag;
  vx *= drag;
  vy *= drag;

  const x = wrap(state.x + vx * dt, arena.width);
  const y = wrap(state.y + vy * dt, arena.height);

  // Перезарядка — ціле число кроків.
  let cooldown = state.cooldown > 0 ? state.cooldown - 1 : 0;
  let fired: 0 | 1 | 2 = 0;
  if (input.fire !== 0 && cooldown === 0) {
    fired = input.fire;
    cooldown = state.rapid ? SHIP.rapidCooldownTicks : SHIP.cooldownTicks;
  }

  return {
    x,
    y,
    vx,
    vy,
    angle,
    cooldown,
    rapid: state.rapid,
    thrusting,
    fired,
  };
}

// Де й з якою швидкістю вилітає куля. Куля успадковує частину швидкості
// корабля. Використовують і сервер (Ship.fire), і клієнт (локальна куля).
export function muzzle(state: ShipState, homing = false): Muzzle {
  const dx = cos(state.angle);
  const dy = sin(state.angle);
  const speed = homing ? SHIP.homingBulletSpeed : SHIP.bulletSpeed;
  return {
    x: state.x + dx * SHIP.muzzle,
    y: state.y + dy * SHIP.muzzle,
    vx: dx * speed + state.vx * SHIP.inheritVelocity,
    vy: dy * speed + state.vy * SHIP.inheritVelocity,
    angle: state.angle,
  };
}
