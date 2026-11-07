import { DT } from "../constants.ts";
import { NO_ENTITY, type EntityId } from "../types.ts";
import type { AnyEntity } from "./entities.ts";
import type { World } from "./world.ts";
import { Vector2 } from "./vector.ts";

// Числові коди видів сутностей для снапшота (u8).
export const KIND = { ship: 1, bullet: 2, asteroid: 3, pickup: 4 } as const;

export type EntityKind = keyof typeof KIND;
export type KindCode = (typeof KIND)[EntityKind];

export const KIND_NAME: { readonly [code in KindCode]: EntityKind } = {
  1: "ship",
  2: "bullet",
  3: "asteroid",
  4: "pickup",
};

// Плоский запис сутності для снапшота: лише числа, без посилань.
// flags/a/b/c — поля, специфічні для виду (див. наслідників).
export interface EntityRecord {
  readonly id: EntityId;
  readonly kind: KindCode;
  readonly flags: number;
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly angle: number;
  readonly a: number;
  readonly b: number;
  readonly c: number;
}

// Компонент, що вмикається на будь-яку сутність (композиція).
export interface Behavior {
  update(entity: Entity, dt: number, world: World): void;
}

// Базова сутність. id призначає World при spawn (а не глобальний лічильник):
// тоді нумерація детермінована й вміщується в Uint16 незалежно від кількості
// світів у процесі. Вид (`kind`) — літерал у кожному наслідникові: саме він
// робить union AnyEntity дискримінованим.
export abstract class Entity {
  abstract readonly kind: EntityKind;
  id: EntityId = NO_ENTITY;
  pos: Vector2;
  vel: Vector2 = new Vector2(0, 0);
  angle = 0;
  radius: number;
  alive = true;
  readonly behaviors: Behavior[] = [];

  constructor(x: number, y: number, radius = 10) {
    this.pos = new Vector2(x, y);
    this.radius = radius;
  }

  // Чи бере сутність участь у зіткненнях.
  get collidable(): boolean {
    return true;
  }

  addBehavior(behavior: Behavior): this {
    this.behaviors.push(behavior);
    return this;
  }

  update(_world: World): void {
    for (const behavior of this.behaviors) {
      behavior.update(this, DT, _world);
    }
    this.pos = this.pos.add(this.vel.scale(DT));
  }

  abstract toSnapshot(): EntityRecord;

  protected record(flags = 0, a = 0, b = 0, c = 0): EntityRecord {
    return {
      id: this.id,
      kind: KIND[this.kind],
      flags,
      x: this.pos.x,
      y: this.pos.y,
      vx: this.vel.x,
      vy: this.vel.y,
      angle: this.angle,
      a,
      b,
      c,
    };
  }

  protected applyRecord(rec: EntityRecord): this {
    this.id = rec.id;
    this.pos = new Vector2(rec.x, rec.y);
    this.vel = new Vector2(rec.vx, rec.vy);
    this.angle = rec.angle;
    return this;
  }
}

// Допоміжний тип: сутність конкретного виду з union.
export type EntityOf<K extends EntityKind> = Extract<AnyEntity, { kind: K }>;
