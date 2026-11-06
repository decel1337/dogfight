import { cos, sin } from "./dmath.js";
// Незмінний 2D-вектор: кожен метод повертає новий. Для стабільності між
// рушіями вживаємо Math.sqrt (точно округлюється за IEEE 754), а не Math.hypot.
export class Vector2 {
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  static fromAngle(angle) {
    return new Vector2(cos(angle), sin(angle));
  }

  add(v) {
    return new Vector2(this.x + v.x, this.y + v.y);
  }

  sub(v) {
    return new Vector2(this.x - v.x, this.y - v.y);
  }

  scale(s) {
    return new Vector2(this.x * s, this.y * s);
  }

  length() {
    return Math.sqrt(this.x * this.x + this.y * this.y);
  }

  dist(v) {
    const dx = this.x - v.x;
    const dy = this.y - v.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  normalize() {
    const len = this.length();
    return len === 0
      ? new Vector2(0, 0)
      : new Vector2(this.x / len, this.y / len);
  }

  rotate(angle) {
    const cos = cos(angle);
    const sin = sin(angle);
    return new Vector2(
      this.x * cos - this.y * sin,
      this.x * sin + this.y * cos,
    );
  }

  dot(v) {
    return this.x * v.x + this.y * v.y;
  }

  lerp(v, t) {
    return new Vector2(
      this.x + (v.x - this.x) * t,
      this.y + (v.y - this.y) * t,
    );
  }
}

const TWO_PI = Math.PI * 2;

// Кут у діапазон [-π, π].
export function normalizeAngle(angle) {
  let a = angle;
  while (a > Math.PI) a -= TWO_PI;
  while (a < -Math.PI) a += TWO_PI;
  return a;
}

// Інтерполяція кута по найкоротшій дузі (без «прокрутки» через ±π).
export function lerpAngle(from, to, t) {
  let diff = (to - from) % TWO_PI;
  if (diff > Math.PI) diff -= TWO_PI;
  if (diff < -Math.PI) diff += TWO_PI;
  return from + diff * t;
}
