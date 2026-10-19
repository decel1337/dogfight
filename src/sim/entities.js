import { HomingBehavior } from "./behaviors.js";
import { Entity } from "./entity.js";
import { Vector2 } from "./vector.js";

// Бонуси задані даними, а не підкласами: новий бонус = новий запис.
export const PICKUP_EFFECTS = {
  shield: (ship) => ship.activateShield(),
  rapid: (ship) => ship.activateRapidFire(8),
};

// 1. Корабель (єдине місце, де є наслідування від Entity глибше за базу).
export class Ship extends Entity {
  static MAX_HP = 3;
  static RESPAWN_DELAY = 2;
  static FIRE_COOLDOWN = 0.18;
  static RAPID_COOLDOWN = 0.07;

  #hp = Ship.MAX_HP;

  constructor(x, y, { name = "Ace" } = {}) {
    super(x, y, 14, "ship");
    this.name = name;
    this.score = 0;
    this.thrusting = false;
    this.dead = false;
    this.respawnTimer = 0;
    this.invulnerable = 0;
    this.shield = false;
    this.rapidTimer = 0;
    this.cooldown = 0;
  }

  get hp() {
    return this.#hp;
  }

  // Мертвий корабель чекає респавну і ні з чим не стикається.
  get collidable() {
    return !this.dead;
  }

  activateShield() {
    this.shield = true;
  }

  activateRapidFire(seconds) {
    this.rapidTimer = seconds;
  }

  addScore(points) {
    this.score += points;
  }

  fire(world, { homing = false } = {}) {
    if (this.dead || this.cooldown > 0) return null;

    const dir = Vector2.fromAngle(this.angle);
    const nose = this.pos.add(dir.scale(18));
    // Куля успадковує частину швидкості корабля.
    const vel = homing
      ? this.vel.scale(0.3).add(dir.scale(160))
      : dir.scale(420).add(this.vel.scale(0.3));
    const bullet = world.spawn(
      new Bullet(nose.x, nose.y, vel, this.angle, {
        ownerId: this.id,
        homing,
      }),
    );
    this.cooldown =
      this.rapidTimer > 0 ? Ship.RAPID_COOLDOWN : Ship.FIRE_COOLDOWN;
    world.emit("fired", { shooter: this });
    return bullet;
  }

  // Повертає true, якщо удар «зараховано» (шкода або поглинання щитом).
  takeDamage(world, amount = 1) {
    if (this.dead || this.invulnerable > 0) return false;

    world.emit("hit", { target: this });
    if (this.shield) {
      this.shield = false;
      return true;
    }

    this.#hp = Math.max(0, this.#hp - amount);
    if (this.#hp === 0) this.#explode(world);
    return true;
  }

  #explode(world) {
    this.dead = true;
    this.thrusting = false;
    this.respawnTimer = Ship.RESPAWN_DELAY;
    this.vel = new Vector2(0, 0);
    world.spawn(new Explosion(this.pos.x, this.pos.y, 28, world.rng));
    world.emit("exploded", { target: this });
  }

  #respawn(world) {
    const spot = world.findSafeSpot(this.radius * 6);
    this.pos = spot;
    this.snapPrev();
    this.vel = new Vector2(0, 0);
    this.#hp = Ship.MAX_HP;
    this.dead = false;
    this.shield = false;
    this.invulnerable = 1.5;
  }

  update(dt, world, input) {
    if (this.dead) {
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0) this.#respawn(world);
      return;
    }

    this.cooldown = Math.max(0, this.cooldown - dt);
    this.invulnerable = Math.max(0, this.invulnerable - dt);
    this.rapidTimer = Math.max(0, this.rapidTimer - dt);

    if (input) {
      if (input.isDown("ArrowLeft") || input.isDown("KeyA")) {
        this.angle -= 3.5 * dt;
      }
      if (input.isDown("ArrowRight") || input.isDown("KeyD")) {
        this.angle += 3.5 * dt;
      }

      this.thrusting = input.isDown("ArrowUp") || input.isDown("KeyW");
      if (this.thrusting) {
        const push = Vector2.fromAngle(this.angle).scale(320 * dt);
        this.vel = this.vel.add(push);
      }

      if (input.isDown("Space")) this.fire(world);
      if (input.justPressed("KeyH")) this.fire(world, { homing: true });
    }

    this.vel = this.vel.scale(0.985 ** (dt * 60));
    super.update(dt, world);
  }
}

// 2. Куля
export class Bullet extends Entity {
  constructor(x, y, vel, angle, { ownerId = null, homing = false } = {}) {
    super(x, y, 3, "bullet");
    this.vel = vel;
    this.angle = angle;
    this.ownerId = ownerId;
    this.ttl = homing ? 4 : 1.8;
    if (homing) {
      this.addBehavior(
        new HomingBehavior({ speed: 320, turnRate: 5, targetKind: "asteroid" }),
      );
    }
  }

  update(dt, world) {
    this.ttl -= dt;
    if (this.ttl <= 0) {
      this.alive = false;
      return;
    }
    super.update(dt, world);
  }
}

// 3. Астероїд
export class Asteroid extends Entity {
  #hp = 1;

  constructor(x, y, radius = 22, { homing = false, rng = Math.random } = {}) {
    super(x, y, radius, "asteroid");
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
    world.spawn(new Explosion(this.pos.x, this.pos.y, 14, world.rng));
    world.emit("exploded", { target: this });
    return true;
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
}

// 5. Вибух із частинок
export class Explosion extends Entity {
  constructor(x, y, count = 16, rng = Math.random) {
    super(x, y, 0, "explosion");
    this.ttl = 0.6;
    this.particles = [];
    for (let i = 0; i < count; i++) {
      const angle = rng() * Math.PI * 2;
      const speed = 40 + rng() * 120;
      this.particles.push({
        pos: new Vector2(x, y),
        vel: Vector2.fromAngle(angle).scale(speed),
      });
    }
  }

  get collidable() {
    return false;
  }

  update(dt) {
    this.ttl -= dt;
    if (this.ttl <= 0) {
      this.alive = false;
      return;
    }
    for (const p of this.particles) {
      p.pos = p.pos.add(p.vel.scale(dt));
    }
  }
}
