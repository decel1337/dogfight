import { createInput } from "./input.js";
import { createLoop } from "./loop.js";
import { setupCanvas } from "./render/canvas.js";
import { drawWorld } from "./render/draw.js";
import { Asteroid, Bullet, Pickup, Ship } from "./sim/entities.js";
import { World } from "./sim/world.js";

const canvas = document.getElementById("gameCanvas");
const { ctx, getLogicalSize } = setupCanvas(canvas);
const input = createInput(window);

const world = new World();
const ship = new Ship(window.innerWidth / 2, window.innerHeight / 2);
world.spawn(ship);

for (let i = 0; i < 4; i++) {
  world.spawn(
    new Asteroid(
      Math.random() * window.innerWidth,
      Math.random() * window.innerHeight,
      22,
      false,
    ),
  );
}
world.spawn(new Asteroid(100, 100, 24, true));

world.spawn(new Pickup(window.innerWidth * 0.35, window.innerHeight * 0.35));

window.addEventListener("click", () => {
  ship.fire(world);
});

window.addEventListener("keydown", (e) => {
  if (e.code === "KeyH" && ship.alive) {
    const nose = ship.pos.add(ship.vel.normalize().scale(22));
    world.spawn(
      new Bullet(nose.x, nose.y, ship.vel.scale(1.4), ship.angle, true),
    );
  }
});

const loop = createLoop({
  step: 1 / 60,
  simulate(dt) {
    world.step(dt, input, getLogicalSize());
    input.flush();
  },
  render(alpha) {
    const { width, height } = getLogicalSize();
    ctx.clearRect(0, 0, width, height);
    drawWorld(ctx, world, loop.getStats(), alpha);
  },
});

loop.start();
