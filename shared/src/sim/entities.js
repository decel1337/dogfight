import { BULLET, DT, SHIP } from "../constants.js";
import { HomingBehavior } from "./behaviors.js";
import { Entity } from "./entity.js";
import { integrate, muzzle } from "./integrate.js";
import { Vector2 } from "./vector.js";

// Біти flags для корабля.
export const SHIP_FLAGS = Object.freeze({
  thrusting: 1,
  shield: 2,
  dead: 4,
  invulnerable: 8,
  rapid: 16,
});
export const HOMING_FLAG = 1;

// Результат takeDamage.
export const DAMAGE = Object.freeze({ none: 0, hit: 1, killed: 2 });

// Бонуси задані даними: новий бонус = новий запис, а не новий підклас.
export const PICKUP_TYPES = Object.freeze(["shield", "rapid"]);
export const PICKUP_EFFECTS = {
  shield: (ship) => ship.activateShield(),
  rapid: (ship) => ship.activateRapidFire(),
};

// 1. Корабель. Рухається ЛИШЕ через applyInput (спільний integrate), тож
// клієнт може відтворити його рух з тих самих input. Таймери (респавн,
// невразливість, бонус) йдуть у кроках світу.
export class Ship extends Entity {
  #hp = SHIP.maxHp;

  constructor(x, y, { playerId = 0 } = {}) {
    super(x, y, SHIP.radius, "ship");
    this.playerId = playerId;
    this.score = 0;
    this.thrusting = false;
    this.dead = false;
    this.respawnTicks = 0;
    this.invulnerableTicks = 0;
    this.shield = false;
    this.rapidTicks = 0;
    this.cooldown = 0;
  }

  get hp() {
    return this.#hp;
  }

  // Мертвий корабель чекає респавну і ні з чим не стикається.
  get collidable() {
    return !this.dead;
  }

  // Стан, який приймає integrate (і який клієнт відновлює зі снапшота).
  state() {
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
  applyInput(input, world) {
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

  fire(homing, seq, world) {
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

  addScore(points) {
    this.score = Math.min(0xffff, this.score + points);
  }

  activateShield() {
    this.shield = true;
  }

  activateRapidFire() {
    this.rapidTicks = SHIP.rapidTicks;
  }

  // Повертає DAMAGE.*: чи зараховано удар і чи загинув корабель.
  takeDamage(world, amount = 1) {
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

  #respawn(world) {
    this.pos = world.findSafeSpot(this.radius * 6);
    this.vel = new Vector2(0, 0);
    this.#hp = SHIP.maxHp;
    this.dead = false;
    this.shield = false;
    this.cooldown = 0;
    this.invulnerableTicks = SHIP.invulnerableTicks;
  }

  // Крок світу: лише таймери (рух — у applyInput).
  update(world) {
    if (this.dead) {
      this.respawnTicks--;
      if (this.respawnTicks <= 0) this.#respawn(world);
      return;
    }
    if (this.invulnerableTicks > 0) this.invulnerableTicks--;
    if (this.rapidTicks > 0) this.rapidTicks--;
  }

  toSnapshot() {
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
  static fromSnapshot(rec) {
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
  constructor(x, y, vel, angle, { ownerId = 0, homing = false, tag = 0 } = {}) {
    super(x, y, BULLET.radius, "bullet");
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

  update(world) {
    this.ttl--;
    if (this.ttl <= 0) {
      this.alive = false;
      return;
    }
    super.update(world);
  }

  toSnapshot() {
    return this.record(
      this.homing ? HOMING_FLAG : 0,
      0,
      this.tag,
      this.ownerId,
    );
  }

  static fromSnapshot(rec) {
    const homing = (rec.flags & HOMING_FLAG) !== 0;
    const bullet = new Bullet(
      rec.x,
      rec.y,
      new Vector2(rec.vx, rec.vy),
      rec.angle,
      {
        ownerId: rec.c,
        homing,
        tag: rec.b,
      },
    );
    bullet.id = rec.id;
    return bullet;
  }
}

// 3. Астероїд
export class Asteroid extends Entity {
  #hp = 1;

  constructor(x, y, radius = 22, { homing = false, rng } = {}) {
    super(x, y, radius, "asteroid");
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
  takeDamage(world, amount = 1) {
    if (!this.alive) return false;
    this.#hp -= amount;
    if (this.#hp > 0) return false;
    this.alive = false;
    world.emit("exploded", { id: this.id, x: this.pos.x, y: this.pos.y });
    return true;
  }

  toSnapshot() {
    return this.record(this.homing ? HOMING_FLAG : 0, Math.round(this.radius));
  }

  static fromSnapshot(rec) {
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
  constructor(x, y, type = "shield") {
    super(x, y, 10, "pickup");
    this.type = type;
  }

  applyTo(ship) {
    PICKUP_EFFECTS[this.type]?.(ship);
    this.alive = false;
  }

  update() {
    // нерухомий
  }

  toSnapshot() {
    return this.record(0, PICKUP_TYPES.indexOf(this.type));
  }

  static fromSnapshot(rec) {
    const pickup = new Pickup(rec.x, rec.y, PICKUP_TYPES[rec.a]);
    pickup.applyRecord(rec);
    return pickup;
  }
}

export const ENTITY_CLASSES = Object.freeze({
  1: Ship,
  2: Bullet,
  3: Asteroid,
  4: Pickup,
});
