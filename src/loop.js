export function createLoop({ step = 1 / 60, simulate, render }) {
  let accumulator = 0;
  let lastTime = performance.now();
  let rafId = null;
  let running = false;

  let framesThisSec = 0;
  let stepsThisSec = 0;
  let lastFpsUpdate = performance.now();
  let fps = 0;
  let sps = 0;
  let frameTime = 0;

  function frame(now) {
    if (!running) return;

    const frameStart = performance.now();
    const rawDelta = (now - lastTime) / 1000;
    lastTime = now;

    // Обмеження дельти для захисту від "спіралі смерті" після підвисання
    const dt = Math.min(rawDelta, 0.25);
    accumulator += dt;

    while (accumulator >= step) {
      simulate(step);
      accumulator -= step;
      stepsThisSec++;
    }

    const alpha = accumulator / step;
    render(alpha);
    framesThisSec++;

    frameTime = performance.now() - frameStart;

    if (now - lastFpsUpdate >= 1000) {
      fps = framesThisSec;
      sps = stepsThisSec;
      framesThisSec = 0;
      stepsThisSec = 0;
      lastFpsUpdate = now;
    }

    rafId = requestAnimationFrame(frame);
  }

  return {
    start() {
      if (running) return;
      running = true;
      lastTime = performance.now();
      lastFpsUpdate = performance.now();
      rafId = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
    },
    getStats: () => ({ fps, sps, frameTime }),
  };
}
