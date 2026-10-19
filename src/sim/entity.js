import { Vector2 } from "./vector.js";

// Базова сутність. Вектори незмінні (кожен метод повертає новий), тому
// «попередній стан» для інтерполяції — це просто збережене посилання.
export class Entity {
  static #nextId = 1;
  #id;

  constructor(x, y, radius = 10, kind = "entity") {
    this.#id = Entity.#nextId++;
    this.pos = new Vector2(x, y);
    this.vel = new Vector2(0, 0);
    this.angle = 0;
    this.prevPos = this.pos;
    this.prevAngle = this.angle;
    this.radius = radius;
    this.alive = true;
    this.kind = kind;
    this.behaviors = [];
  }

  get id() {
    return this.#id;
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

  savePrev() {
    this.prevPos = this.pos;
    this.prevAngle = this.angle;
  }

  // Після телепорту (wrap) інтерполяція не має малювати смугу через арену.
  snapPrev() {
    this.prevPos = this.pos;
    this.prevAngle = this.angle;
  }

  update(dt, world) {
    for (const behavior of this.behaviors) {
      behavior.update(this, dt, world);
    }
    this.pos = this.pos.add(this.vel.scale(dt));
  }
}
