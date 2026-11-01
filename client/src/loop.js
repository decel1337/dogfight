// Чистий акумулятор часу: не знає про requestAnimationFrame, тому його
// можна тестувати в Node. Повертає alpha для інтерполяції рендеру.
export function createAccumulator({ step = 1 / 60, maxFrame = 0.25 } = {}) {
  let acc = 0;
  return {
    push(frameSeconds, simulate) {
      acc += Math.min(frameSeconds, maxFrame);
      let steps = 0;
      while (acc >= step) {
        simulate(step);
        acc -= step;
        steps++;
      }
      return { steps, alpha: acc / step };
    },
  };
}

export function createLoop({ step = 1 / 60, simulate, render, maxFrame }) {
  const accumulator = createAccumulator({ step, maxFrame });
  const metrics = { stepsPerSecond: 0, fps: 0, frameMs: 0 };

  let rafId = null;
  let last = null;
  let windowStart = 0;
  let steps = 0;
  let frames = 0;

  function frame(time) {
    if (last === null) {
      last = time;
      windowStart = time;
    }
    const frameMs = time - last;
    last = time;

    const result = accumulator.push(frameMs / 1000, simulate);
    steps += result.steps;
    frames++;
    metrics.frameMs = frameMs;

    if (time - windowStart >= 500) {
      const seconds = (time - windowStart) / 1000;
      metrics.stepsPerSecond = Math.round(steps / seconds);
      metrics.fps = Math.round(frames / seconds);
      steps = 0;
      frames = 0;
      windowStart = time;
    }

    render(result.alpha, metrics);
    rafId = requestAnimationFrame(frame);
  }

  return {
    metrics,
    start() {
      if (rafId !== null) return;
      last = null;
      rafId = requestAnimationFrame(frame);
    },
    stop() {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
    },
  };
}
