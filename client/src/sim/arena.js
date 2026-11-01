import { Vector2 } from "./vector.js";

const wrap = (value, size) => ((value % size) + size) % size;

// Замикає арену в тор. Повертає true, якщо сутність «телепортувалась».
export function wrapBounds(entity, width, height) {
  const { x, y } = entity.pos;
  if (x >= 0 && x < width && y >= 0 && y < height) return false;

  entity.pos = new Vector2(wrap(x, width), wrap(y, height));
  entity.snapPrev();
  return true;
}
