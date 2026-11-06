import { lerpAngle } from "../sim/vector.js";

// Найкоротша різниця на торі: арена замикається, тож відстань між x=1195 і
// x=5 при ширині 1200 — це 10, а не 1190.
export function shortestDelta(delta, size) {
  const half = size / 2;
  if (delta > half) return delta - size;
  if (delta < -half) return delta + size;
  return delta;
}

export const wrapInto = (value, size) => ((value % size) + size) % size;

// Інтерполяція координати через шов тору.
export function lerpWrap(from, to, t, size) {
  return wrapInto(from + shortestDelta(to - from, size) * t, size);
}

export { lerpAngle };
