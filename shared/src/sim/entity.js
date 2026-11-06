import { DT } from "../constants.js";
import { Vector2 } from "./vector.js";

// Числові коди видів сутностей для снапшота (u8).
export const KIND = Object.freeze({
  ship: 1,
  bullet: 2,
  asteroid: 3,
  pickup: 4,
});
export const KIND_NAME = Object.freeze({
  1: "ship",
  2: "bullet",
  3: "asteroid",
  4: "pickup",
});

// Базова сутність. id призначає World при spawn (а не глобальний лічильник):
// тоді нумерація детермінована й вміщується в Uint16 незалежно від кількості
// світів у процесі.
export class Entity {
  constructor(x, y, radius = 10, kind = "entity") {
    this.id = 0;
    this.pos = new Vector2(x, y);
    this.vel = new Vector2(0, 0);
    this.angle = 0;
    this.radius = radius;
    this.alive = true;
    this.kind = kind;
    this.behaviors = [];
  }

  // Чи бере сутність участь у зіткненнях.
  get collidable() {
    return true;
  }

  // Композиція: поведінки підключаються до будь-якої сутності.
  addBehavior(behavior) {
    this.behaviors.push(behavior);
    return this;
  }

  update(world) {
    for (const behavior of this.behaviors) {
      behavior.update(this, DT, world);
    }
    this.pos = this.pos.add(this.vel.scale(DT));
  }

  // Запис для снапшота: плоскі числа, без посилань на інші об'єкти.
  // flags/a/b/c — поля, специфічні для виду (див. наслідників).
  record(flags = 0, a = 0, b = 0, c = 0) {
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

  applyRecord(rec) {
    this.id = rec.id;
    this.pos = new Vector2(rec.x, rec.y);
    this.vel = new Vector2(rec.vx, rec.vy);
    this.angle = rec.angle;
    return this;
  }
}
