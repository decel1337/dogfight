export class Vector2 {
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  static fromAngle(angle) {
    return new Vector2(Math.cos(angle), Math.sin(angle));
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
    return Math.hypot(this.x, this.y);
  }

  dist(v) {
    return Math.hypot(this.x - v.x, this.y - v.y);
  }

  normalize() {
    const len = this.length();
    return len === 0
      ? new Vector2(0, 0)
      : new Vector2(this.x / len, this.y / len);
  }

  rotate(angle) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return new Vector2(
      this.x * cos - this.y * sin,
      this.x * sin + this.y * cos,
    );
  }

  dot(v) {
    return this.x * v.x + this.y * v.y;
  }

  lerp(v, t) {
    return new Vector2(this.x + (v.x - this.x) * t, this.y + (v.y - this.y) * t);
  }
}

// Інтерполяція кута по найкоротшій дузі (без «прокрутки» через ±π).
export function lerpAngle(from, to, t) {
  let diff = (to - from) % (Math.PI * 2);
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return from + diff * t;
}
