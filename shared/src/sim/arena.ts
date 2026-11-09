import type { Entity } from "./entity.ts";
import { Vector2 } from "./vector.ts";

const wrap = (value: number, size: number): number =>
  ((value % size) + size) % size;

// Тор: вийшов за край — з'явився з протилежного боку.
export function wrapBounds(
  entity: Entity,
  width: number,
  height: number,
): void {
  const { x, y } = entity.pos;
  if (x >= 0 && x < width && y >= 0 && y < height) return;
  entity.pos = new Vector2(wrap(x, width), wrap(y, height));
}
