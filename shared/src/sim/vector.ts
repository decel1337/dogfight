import { cos, sin } from "./dmath.ts";
// Незмінний 2D-вектор: кожен метод повертає новий. Для стабільності між
// рушіями вживаємо Math.sqrt (точно округлюється за IEEE 754), а не Math.hypot.
export class Vector2 {
  readonly x: number;
  readonly y: number;

  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  static fromAngle(angle: number): Vector2 {
    return new Vector2(cos(angle), sin(angle));
  }

  add(v: Vector2): Vector2 {
    return new Vector2(this.x + v.x, this.y + v.y);
  }

  sub(v: Vector2): Vector2 {
    return new Vector2(this.x - v.x, this.y - v.y);
  }

  scale(s: number): Vector2 {
    return new Vector2(this.x * s, this.y * s);
  }

  length(): number {
    return Math.sqrt(this.x * this.x + this.y * this.y);
  }

  dist(v: Vector2): number {
    const dx = this.x - v.x;
    const dy = this.y - v.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  normalize(): Vector2 {
    const len = this.length();
    return len === 0
      ? new Vector2(0, 0)
      : new Vector2(this.x / len, this.y / len);
  }

  rotate(angle: number): Vector2 {
    const c = cos(angle);
    const s = sin(angle);
    return new Vector2(
      this.x * c - this.y * s,
      this.x * s + this.y * c,
    );
  }

  dot(v: Vector2): number {
    return this.x * v.x + this.y * v.y;
  }

  lerp(v: Vector2, t: number): Vector2 {
    return new Vector2(
      this.x + (v.x - this.x) * t,
      this.y + (v.y - this.y) * t,
    );
  }
}

const TWO_PI = Math.PI * 2;

// Кут у діапазон [-π, π].
export function normalizeAngle(angle: number): number {
  let a = angle;
  while (a > Math.PI) a -= TWO_PI;
  while (a < -Math.PI) a += TWO_PI;
  return a;
}

// Інтерполяція кута по найкоротшій дузі (без «прокрутки» через ±π).
export function lerpAngle(from: number, to: number, t: number): number {
  let diff = (to - from) % TWO_PI;
  if (diff > Math.PI) diff -= TWO_PI;
  if (diff < -Math.PI) diff += TWO_PI;
  return from + diff * t;
}
