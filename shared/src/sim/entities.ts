import { BULLET, DT, SHIP } from "../constants.ts";
import { HomingBehavior } from "./behaviors.ts";
import { assertNever, entityId, type EntityId, NO_ENTITY, type PlayerId } from "../types.ts";
import type { Rng } from "../prng.ts";
import { Entity, type EntityKind, type EntityOf, type EntityRecord, type KindCode } from "./entity.ts";
import { type Controls, integrate, muzzle, type ShipState } from "./integrate.ts";
import { Vector2 } from "./vector.ts";
import type { World } from "./world.ts";

// Біти flags для корабля.
export const SHIP_FLAGS = {
  thrusting: 1,
  shield: 2,
  dead: 4,
  invulnerable: 8,
  rapid: 16,
} as const;
export const HOMING_FLAG = 1;

// Результат takeDamage.
export const DAMAGE = { none: 0, hit: 1, killed: 2 } as const;
export type Damage = (typeof DAMAGE)[keyof typeof DAMAGE];

// Бонуси задані даними: новий бонус = новий запис, а не новий підклас.
export const PICKUP_TYPES = ["shield", "rapid"] as const;
export type PickupType = (typeof PICKUP_TYPES)[number];

export const PICKUP_EFFECTS: { readonly [T in PickupType]: (ship: Ship) => void } = {
  shield: (ship) => ship.activateShield(),
  rapid: (ship) => ship.activateRapidFire(),
};

// 1. Корабель. Рухається ЛИШЕ через applyInput (спільний integrate), тож
// клієнт може відтворити його рух з тих самих input. Таймери (респавн,
// невразливість, бонус) йдуть у кроках світу.
export class Ship extends Entity {
  readonly kind: "ship" = "ship";
  #hp: number = SHIP.maxHp;
  readonly playerId: PlayerId | null;
  score = 0;
  thrusting = false;
  dead = false;
  respawnTicks = 0;
  invulnerableTicks = 0;
  shield = false;
  rapidTicks = 0;
  cooldown = 0;

  constructor(x: number, y: number, { playerId = null }: { playerId?: PlayerId | null } = {}) {
    super(x, y, SHIP.radius);
    this.playerId = playerId;
  }

  get hp(): number {
    return this.#hp;
  }

  // Мертвий корабель чекає респавну і ні з чим не стикається.
  override get collidable(): boolean {
    return !this.dead;
  }

  // Стан, який приймає integrate (і який клієнт відновлює зі снапшота).
  state(): ShipState {
    return {
      x: this.pos.x,
      y: this.pos.y,
      vx: this.vel.x,
      vy: this.vel.y,
      angle: this.angle,
      cooldown: this.cooldown,
      rapid: this.rapidTicks > 0,
    };
  }

  // Один крок input гравця. Повертає кулю, якщо був постріл.
  applyInput(input: Controls & { readonly seq: number }, world: World): Bullet | null {
    if (this.dead) return null;
    const next = integrate(this.state(), input, DT, world.arena);
    this.pos = new Vector2(next.x, next.y);
    this.vel = new Vector2(next.vx, next.vy);
    this.angle = next.angle;
    this.cooldown = next.cooldown;
    this.thrusting = next.thrusting;
    if (next.fired === 0) return null;
    return this.fire(next.fired === 2, input.seq, world);
  }

  fire(homing: boolean, seq: number, world: World): Bullet {
    const m = muzzle(this.state(), homing);
    const bullet = new Bullet(m.x, m.y, new Vector2(m.vx, m.vy), m.angle, {
      ownerId: this.id,
      homing,
      tag: seq & 0xff,
    });
    world.spawn(bullet);
    world.emit("fired", { id: this.id, x: m.x, y: m.y });
    return bullet;
  }

  addScore(points: number): void {
    this.score = Math.min(0xffff, this.score + points);
  }

  activateShield(): void {
    this.shield = true;
  }

  activateRapidFire(): void {
    this.rapidTicks = SHIP.rapidTicks;
  }

  // Повертає DAMAGE.*: чи зараховано удар і чи загинув корабель.
  takeDamage(world: World, amount = 1): Damage {
    if (this.dead || this.invulnerableTicks > 0) return DAMAGE.none;

    world.emit("hit", { id: this.id, x: this.pos.x, y: this.pos.y });
    if (this.shield) {
      this.shield = false;
      return DAMAGE.hit;
    }

    this.#hp = Math.max(0, this.#hp - amount);
    if (this.#hp > 0) return DAMAGE.hit;

    this.dead = true;
    this.thrusting = false;
    this.respawnTicks = SHIP.respawnTicks;
    this.vel = new Vector2(0, 0);
    world.emit("exploded", { id: this.id, x: this.pos.x, y: this.pos.y });
    return DAMAGE.killed;
  }

  #respawn(world: World): void {
    this.pos = world.findSafeSpot(this.radius * 6);
    this.vel = new Vector2(0, 0);
    this.#hp = SHIP.maxHp;
    this.dead = false;
    this.shield = false;
    this.cooldown = 0;
    this.invulnerableTicks = SHIP.invulnerableTicks;
  }

  // Крок світу: лише таймери (рух — у applyInput).
  override update(world: World): void {
    if (this.dead) {
      this.respawnTicks--;
      if (this.respawnTicks <= 0) this.#respawn(world);
      return;
    }
    if (this.invulnerableTicks > 0) this.invulnerableTicks--;
    if (this.rapidTicks > 0) this.rapidTicks--;
  }

  toSnapshot(): EntityRecord {
    const flags =
      (this.thrusting ? SHIP_FLAGS.thrusting : 0) |
      (this.shield ? SHIP_FLAGS.shield : 0) |
      (this.dead ? SHIP_FLAGS.dead : 0) |
      (this.invulnerableTicks > 0 ? SHIP_FLAGS.invulnerable : 0) |
      (this.rapidTicks > 0 ? SHIP_FLAGS.rapid : 0);
    // b: для мертвого — скільки кроків до респавну, для живого — перезарядка.
    const b = this.dead ? this.respawnTicks : this.cooldown;
    return this.record(flags, this.#hp, b, this.score);
  }

  // Відновлює ЛИШЕ реплікований стан. Серверні таймери (залишок
  // невразливості/бонусу) за снапшотом не відновлюються точно: лишається
  // приблизне значення за прапорцем.
  static fromSnapshot(rec: EntityRecord): Ship {
    const ship = new Ship(rec.x, rec.y);
    ship.applyRecord(rec);
    ship.#hp = rec.a;
    ship.score = rec.c;
    ship.thrusting = (rec.flags & SHIP_FLAGS.thrusting) !== 0;
    ship.shield = (rec.flags & SHIP_FLAGS.shield) !== 0;
    ship.dead = (rec.flags & SHIP_FLAGS.dead) !== 0;
    if (ship.dead) ship.respawnTicks = rec.b;
    else ship.cooldown = rec.b;
    if (rec.flags & SHIP_FLAGS.invulnerable) {
      ship.invulnerableTicks = SHIP.invulnerableTicks;
    }
    if (rec.flags & SHIP_FLAGS.rapid) ship.rapidTicks = SHIP.rapidTicks;
    return ship;
  }
}

// 2. Куля. `tag` — молодші 8 біт seq input, що її випустив: за ним власник
// пізнає свою кулю в снапшоті (локально передбачена куля -> куля сервера).
export class Bullet extends Entity {
  readonly kind: "bullet" = "bullet";
  readonly ownerId: EntityId;
  readonly tag: number;
  readonly homing: boolean;
  ttl: number;

  constructor(
    x: number,
    y: number,
    vel: Vector2,
    angle: number,
    { ownerId = NO_ENTITY, homing = false, tag = 0 }: { ownerId?: EntityId; homing?: boolean; tag?: number } = {},
  ) {
    super(x, y, BULLET.radius);
    this.vel = vel;
    this.angle = angle;
    this.ownerId = ownerId;
    this.tag = tag;
    this.homing = homing;
    this.ttl = homing ? BULLET.homingTtlTicks : BULLET.ttlTicks;
    if (homing) {
      this.addBehavior(
        new HomingBehavior({ speed: 320, turnRate: 5, targetKind: "asteroid" }),
      );
    }
  }

  override update(world: World): void {
    this.ttl--;
    if (this.ttl <= 0) {
      this.alive = false;
      return;
    }
    super.update(world);
  }

  toSnapshot(): EntityRecord {
    return this.record(this.homing ? HOMING_FLAG : 0, 0, this.tag, this.ownerId);
  }

  static fromSnapshot(rec: EntityRecord): Bullet {
    const homing = (rec.flags & HOMING_FLAG) !== 0;
    const bullet = new Bullet(rec.x, rec.y, new Vector2(rec.vx, rec.vy), rec.angle, {
      ownerId: entityId(rec.c),
      homing,
      tag: rec.b,
    });
    bullet.id = rec.id;
    return bullet;
  }
}

// 3. Астероїд
export class Asteroid extends Entity {
  readonly kind: "asteroid" = "asteroid";
  #hp = 1;
  readonly homing: boolean;

  constructor(
    x: number,
    y: number,
    radius = 22,
    { homing = false, rng }: { homing?: boolean; rng: Rng | (() => number) },
  ) {
    super(x, y, radius);
    this.homing = homing;
    const speed = homing ? 75 : 30 + rng() * 50;
    this.angle = rng() * Math.PI * 2;
    this.vel = Vector2.fromAngle(this.angle).scale(speed);
    if (homing) {
      this.addBehavior(
        new HomingBehavior({ speed: 75, turnRate: 1.2, targetKind: "ship" }),
      );
    }
  }

  // true — якщо астероїд знищено цим ударом.
  takeDamage(world: World, amount = 1): boolean {
    if (!this.alive) return false;
    this.#hp -= amount;
    if (this.#hp > 0) return false;
    this.alive = false;
    world.emit("exploded", { id: this.id, x: this.pos.x, y: this.pos.y });
    return true;
  }

  toSnapshot(): EntityRecord {
    return this.record(this.homing ? HOMING_FLAG : 0, Math.round(this.radius));
  }

  static fromSnapshot(rec: EntityRecord): Asteroid {
    const rng = () => 0;
    const asteroid = new Asteroid(rec.x, rec.y, rec.a, {
      homing: (rec.flags & HOMING_FLAG) !== 0,
      rng,
    });
    asteroid.applyRecord(rec);
    return asteroid;
  }
}

// 4. Нерухомий бонус: не корабель і не куля, але стикається.
export class Pickup extends Entity {
  readonly kind: "pickup" = "pickup";
  readonly type: PickupType;

  constructor(x: number, y: number, type: PickupType = "shield") {
    super(x, y, 10);
    this.type = type;
  }

  applyTo(ship: Ship): void {
    PICKUP_EFFECTS[this.type](ship);
    this.alive = false;
  }

  override update(): void {
    // нерухомий
  }

  toSnapshot(): EntityRecord {
    return this.record(0, PICKUP_TYPES.indexOf(this.type));
  }

  static fromSnapshot(rec: EntityRecord): Pickup {
    const pickup = new Pickup(rec.x, rec.y, PICKUP_TYPES[rec.a] ?? "shield");
    pickup.applyRecord(rec);
    return pickup;
  }
}

// Усі види сутностей. Це ДИСКРИМІНОВАНИЙ union: поле `kind` — літерал,
// тому `switch (e.kind)` звужує тип, а `assertNever` у default ловить
// забутий варіант.
export type AnyEntity = Ship | Bullet | Asteroid | Pickup;

export function isKind<K extends EntityKind>(entity: AnyEntity, kind: K): entity is EntityOf<K> {
  return entity.kind === kind;
}

// Відновлення сутності зі снапшота. Вичерпний switch за кодом виду.
export function entityFromRecord(rec: EntityRecord): AnyEntity {
  const code: KindCode = rec.kind;
  switch (code) {
    case 1:
      return Ship.fromSnapshot(rec);
    case 2:
      return Bullet.fromSnapshot(rec);
    case 3:
      return Asteroid.fromSnapshot(rec);
    case 4:
      return Pickup.fromSnapshot(rec);
    default:
      return assertNever(code, "код виду сутності");
  }
}
