import { Vector2 } from "./vector.js";

const wrap = (value, size) => ((value % size) + size) % size;

// Замикає арену в тор.
export function wrapBounds(entity, width, height) {
  const { x, y } = entity.pos;
  if (x >= 0 && x < width && y >= 0 && y < height) return;
  entity.pos = new Vector2(wrap(x, width), wrap(y, height));
}
