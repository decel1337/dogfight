export function createShip(x = 0, y = 0) {
  return { x, y, vx: 0, vy: 0, angle: 0, thrusting: false, radius: 14 };
}

const ROTATION_SPEED = 3.5;
const THRUST_ACCEL = 350;
const DRAG = 0.985;
const MAX_SPEED = 400;

export function integrate(ship, input, dt) {
  let angle = ship.angle;
  if (input.isDown("KeyA") || input.isDown("ArrowLeft")) angle -= ROTATION_SPEED * dt;
  if (input.isDown("KeyD") || input.isDown("ArrowRight")) angle += ROTATION_SPEED * dt;

  const thrusting = input.isDown("KeyW") || input.isDown("ArrowUp");
  let vx = ship.vx;
  let vy = ship.vy;

  if (thrusting) {
    vx += Math.cos(angle) * THRUST_ACCEL * dt;
    vy += Math.sin(angle) * THRUST_ACCEL * dt;
  }

  vx *= Math.pow(DRAG, dt * 60);
  vy *= Math.pow(DRAG, dt * 60);

  const speed = Math.hypot(vx, vy);
  if (speed > MAX_SPEED) {
    vx = (vx / speed) * MAX_SPEED;
    vy = (vy / speed) * MAX_SPEED;
  }

  return {
    x: ship.x + vx * dt,
    y: ship.y + vy * dt,
    vx,
    vy,
    angle,
    thrusting,
    radius: ship.radius,
  };
}