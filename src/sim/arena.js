export function wrapBounds(state, width, height) {
  let { x, y } = state;
  if (x < 0) x += width;
  else if (x > width) x -= width;

  if (y < 0) y += height;
  else if (y > height) y -= height;

  return { ...state, x, y };
}