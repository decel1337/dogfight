import { Vector2 } from "./vector.js";

// Компонент самонаведення. Не залежить від типу сутності: його можна
// причепити і до кулі, і до астероїда (Lab 02, M4).
export class HomingBehavior {
  constructor({ speed = 220, turnRate = 4, targetKind = "asteroid" } = {}) {
    this.speed = speed;
    this.turnRate = turnRate;
    this.targetKind = targetKind;
  }

  findTarget(entity, world) {
    let nearest = null;
    let best = Infinity;
    for (const candidate of world.ofKind(this.targetKind)) {
      if (!candidate.alive || !candidate.collidable) continue;
      const d = entity.pos.dist(candidate.pos);
      if (d < best) {
        best = d;
        nearest = candidate;
      }
    }
    return nearest;
  }

  update(entity, dt, world) {
    const target = this.findTarget(entity, world);
    if (!target) return;

    const to = target.pos.sub(entity.pos);
    let diff = Math.atan2(to.y, to.x) - entity.angle;
    while (diff < -Math.PI) diff += Math.PI * 2;
    while (diff > Math.PI) diff -= Math.PI * 2;

    const maxTurn = this.turnRate * dt;
    entity.angle += Math.sign(diff) * Math.min(Math.abs(diff), maxTurn);
    entity.vel = Vector2.fromAngle(entity.angle).scale(this.speed);
  }
}
