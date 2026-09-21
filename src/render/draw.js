export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function lerpAngle(a, b, t) {
  const diff = ((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  return a + diff * t;
}

export function interpolateShip(prev, curr, alpha) {
  const wrapThreshold = 100;
  const jumped = Math.hypot(curr.x - prev.x, curr.y - prev.y) > wrapThreshold;

  return {
    x: jumped ? curr.x : lerp(prev.x, curr.x, alpha),
    y: jumped ? curr.y : lerp(prev.y, curr.y, alpha),
    angle: lerpAngle(prev.angle, curr.angle, alpha),
    thrusting: curr.thrusting,
  };
}

export function drawShip(ctx, ship) {
  ctx.save();
  ctx.translate(ship.x, ship.y);
  ctx.rotate(ship.angle);

  ctx.beginPath();
  ctx.moveTo(16, 0);
  ctx.lineTo(-12, -10);
  ctx.lineTo(-6, 0);
  ctx.lineTo(-12, 10);
  ctx.closePath();
  ctx.fillStyle = "#38bdf8";
  ctx.fill();
  ctx.strokeStyle = "#e0f2fe";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  if (ship.thrusting) {
    ctx.beginPath();
    ctx.moveTo(-7, 0);
    ctx.lineTo(-18, -4);
    ctx.lineTo(-24, 0);
    ctx.lineTo(-18, 4);
    ctx.closePath();
    ctx.fillStyle = "#f97316";
    ctx.fill();
  }

  ctx.restore();
}

export function drawHud(ctx, { fps, sps, frameTime }) {
  ctx.save();
  ctx.font = "14px monospace";
  ctx.fillStyle = "#a1a1aa";
  ctx.fillText(`FPS: ${fps}`, 16, 26);
  ctx.fillText(`SPS: ${sps}`, 16, 44);
  ctx.fillText(`Frame Time: ${frameTime.toFixed(2)} ms`, 16, 62);
  ctx.restore();
}