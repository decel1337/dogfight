import { Entity } from "./entity.js";
import { Vector2 } from "./vector.js";

// Допоміжна функція для отримання довжини вектора
function getVecLen(vec) {
  if (typeof vec.len === "function") return vec.len();
  if (typeof vec.length === "function") return vec.length();
  if (typeof vec.magnitude === "function") return vec.magnitude();
  return Math.hypot(vec.x, vec.y);
}

// Компонент поведінки самонаведення
export class HomingBehavior {
  constructor(speed = 220, turnRate = 4) {
    this.speed = speed;
    this.turnRate = turnRate;
  }

  update(entity, dt, target) {
    if (!target?.alive) return;

    const toTarget = target.pos.sub(entity.pos);
    const targetAngle = Math.atan2(toTarget.y, toTarget.x);

    let diff = targetAngle - entity.angle;
    while (diff < -Math.PI) diff += Math.PI * 2;
    while (diff > Math.PI) diff -= Math.PI * 2;

    entity.angle +=
      Math.sign(diff) * Math.min(Math.abs(diff), this.turnRate * dt);
    entity.vel = new Vector2(
      Math.cos(entity.angle),
      Math.sin(entity.angle),
    ).scale(this.speed);
  }
}

// 1. Корабель гравця
export class Ship extends Entity {
  constructor(x, y) {
    super(x, y, 14, "ship");
    this.hp = 3;
    this.maxHp = 3;
    this.score = 0;
    this.thrusting = false;
    this.respawnTimer = 0;
    this.spawnPos = new Vector2(x, y);
    this.shield = false;
  }

  fire(world) {
    if (!this.alive) return;
    const dir = new Vector2(Math.cos(this.angle), Math.sin(this.angle));
    const nose = this.pos.add(dir.scale(18));
    const bulletVel = dir.scale(420).add(this.vel.scale(0.3));
    if (world && typeof world.spawn === "function") {
      world.spawn(new Bullet(nose.x, nose.y, bulletVel, this.angle, false));
    }
  }

  damage(world) {
    if (!this.alive) return;
    if (this.shield) {
      this.shield = false;
      return;
    }
    this.hp -= 1;

    if (world && typeof world.spawn === "function") {
      world.spawn(new Explosion(this.pos.x, this.pos.y, 25));
    }

    if (this.hp <= 0) {
      this.alive = false;
      this.respawnTimer = 2.0;
    }
  }

  takeDamage(world) {
    this.damage(world);
  }

  collect(pickup) {
    if (!pickup) return;
    if (pickup.type === "shield") {
      this.shield = true;
    } else if (pickup.type === "heal") {
      this.hp = Math.min(this.maxHp, this.hp + 1);
    } else {
      this.score += 100;
    }
    pickup.alive = false;
  }

  addScore(points = 100) {
    this.score += points;
  }

  heal(amount = 1) {
    this.hp = Math.min(this.maxHp, this.hp + amount);
  }

  update(dt, _world, input) {
    if (!this.alive) {
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0) {
        this.alive = true;
        this.hp = 3;
        this.pos = new Vector2(this.spawnPos.x, this.spawnPos.y);
        this.vel = new Vector2(0, 0);
      }
      return;
    }

    if (input) {
      if (input.isDown("ArrowLeft") || input.isDown("KeyA")) {
        this.angle -= 3.5 * dt;
      }
      if (input.isDown("ArrowRight") || input.isDown("KeyD")) {
        this.angle += 3.5 * dt;
      }

      this.thrusting = input.isDown("ArrowUp") || input.isDown("KeyW");
      if (this.thrusting) {
        const force = new Vector2(
          Math.cos(this.angle),
          Math.sin(this.angle),
        ).scale(320 * dt);
        this.vel = this.vel.add(force);
      }
    }

    this.vel = this.vel.scale(0.985 ** (dt * 60));
    super.update(dt, _world);
  }
}

// 2. Куля
export class Bullet extends Entity {
  constructor(x, y, vel, angle, homing = false) {
    super(x, y, 3, "bullet");
    this.vel = vel;
    this.angle = angle;
    this.ttl = homing ? 4.0 : 1.8;
    this.homing = homing ? new HomingBehavior(320, 5.0) : null;
  }

  update(dt, world) {
    this.ttl -= dt;
    if (this.ttl <= 0) {
      this.alive = false;
      return;
    }

    if (this.homing && world && typeof world.ofKind === "function") {
      let nearest = null;
      let minDist = Infinity;
      for (const asteroid of world.ofKind("asteroid")) {
        if (!asteroid.alive) continue;
        const d = getVecLen(this.pos.sub(asteroid.pos));
        if (d < minDist) {
          minDist = d;
          nearest = asteroid;
        }
      }
      if (nearest) {
        this.homing.update(this, dt, nearest);
      }
    }

    super.update(dt, world);
  }
}

// 3. Астероїд
export class Asteroid extends Entity {
  constructor(x, y, radius = 22, homing = false) {
    super(x, y, radius, "asteroid");
    this.homing = homing ? new HomingBehavior(75, 1.2) : null;

    const spd = homing ? 75 : 30 + Math.random() * 50;
    const ang = Math.random() * Math.PI * 2;
    this.angle = ang;
    this.vel = new Vector2(Math.cos(ang), Math.sin(ang)).scale(spd);
  }

  update(dt, world) {
    if (this.homing && world && typeof world.ofKind === "function") {
      let ship = null;
      for (const s of world.ofKind("ship")) {
        if (s.alive) {
          ship = s;
          break;
        }
      }
      if (ship) {
        this.homing.update(this, dt, ship);
      }
    }

    super.update(dt, world);
  }
}

// 4. Бонус (Pickup)
export class Pickup extends Entity {
  constructor(x, y, type = "score") {
    super(x, y, 8, "pickup");
    this.type = type;
  }

  // Метод, який очікує collision.js
  applyTo(target) {
    if (target) {
      if (typeof target.collect === "function") {
        target.collect(this);
      } else {
        target.score = (target.score || 0) + 100;
      }
    }
    this.alive = false;
  }

  apply(target) {
    this.applyTo(target);
  }

  onCollect(target) {
    this.applyTo(target);
  }

  update(dt, _world) {
    super.update(dt, _world);
  }
}

// 5. Вибух
export class Explosion extends Entity {
  constructor(x, y, count = 16) {
    super(x, y, 0, "explosion");
    this.ttl = 0.6;
    this.particles = [];

    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 40 + Math.random() * 120;
      this.particles.push({
        pos: new Vector2(x, y),
        vel: new Vector2(Math.cos(angle), Math.sin(angle)).scale(speed),
        life: 0.6,
      });
    }
  }

  update(dt, _world) {
    this.ttl -= dt;
    if (this.ttl <= 0) {
      this.alive = false;
      return;
    }

    for (const p of this.particles) {
      p.pos = p.pos.add(p.vel.scale(dt));
      p.life -= dt;
    }
  }
}
