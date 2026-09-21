import { createLoop } from "./loop.js";
import { createInput } from "./input.js";
import { createShip, integrate } from "./sim/ship.js";
import { wrapBounds } from "./sim/arena.js";
import { setupCanvas } from "./render/canvas.js";
import { drawShip, drawHud, interpolateShip } from "./render/draw.js";

const canvas = document.getElementById("gameCanvas");
const { ctx, getLogicalSize } = setupCanvas(canvas);
const input = createInput(window);

let ship = createShip(window.innerWidth / 2, window.innerHeight / 2);
let previousShip = { ...ship };

const loop = createLoop({
  step: 1 / 60,
  simulate(dt) {
    previousShip = { ...ship };
    const nextState = integrate(ship, input, dt);
    const { width, height } = getLogicalSize();
    ship = wrapBounds(nextState, width, height);
    input.flush();
  },
  render(alpha) {
    const { width, height } = getLogicalSize();
    ctx.clearRect(0, 0, width, height);

    const renderState = interpolateShip(previousShip, ship, alpha);
    drawShip(ctx, renderState);
    drawHud(ctx, loop.getStats());
  },
});

loop.start();