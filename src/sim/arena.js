export function wrapBounds(entity, width, height) {
  if (entity.pos.x < 0) entity.pos.x += width;
  else if (entity.pos.x > width) entity.pos.x -= width;

  if (entity.pos.y < 0) entity.pos.y += height;
  else if (entity.pos.y > height) entity.pos.y -= height;
}
