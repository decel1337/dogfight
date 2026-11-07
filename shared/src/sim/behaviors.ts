import { atan2 } from "./dmath.ts";
import type { Behavior, Entity, EntityKind } from "./entity.ts";
import { Vector2 } from "./vector.ts";
import type { World } from "./world.ts";

// Компонент самонаведення. Не залежить від типу сутності: його можна
// причепити і до кулі, і до астероїда. Ціль шукає за видом (`targetKind`).
export class HomingBehavior implements Behavior {
  readonly speed: number;
  readonly turnRate: number;
  readonly targetKind: EntityKind;

  constructor({
    speed = 220,
    turnRate = 4,
    targetKind = "asteroid",
  }: { speed?: number; turnRate?: number; targetKind?: EntityKind } = {}) {
    this.speed = speed;
    this.turnRate = turnRate;
    this.targetKind = targetKind;
  }

  findTarget(entity: Entity, world: World): Entity | null {
    let nearest: Entity | null = null;
    let best = Number.POSITIVE_INFINITY;
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

  update(entity: Entity, dt: number, world: World): void {
    const target = this.findTarget(entity, world);
    if (!target) return;

    const to = target.pos.sub(entity.pos);
    let diff = atan2(to.y, to.x) - entity.angle;
    while (diff < -Math.PI) diff += Math.PI * 2;
    while (diff > Math.PI) diff -= Math.PI * 2;

    const maxTurn = this.turnRate * dt;
    entity.angle += Math.sign(diff) * Math.min(Math.abs(diff), maxTurn);
    entity.vel = Vector2.fromAngle(entity.angle).scale(this.speed);
  }
}
