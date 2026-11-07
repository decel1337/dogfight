// Чистий акумулятор часу: не знає про requestAnimationFrame, тому його
// можна тестувати в Node. Повертає alpha для інтерполяції рендеру.
export function createAccumulator({
  step = 1 / 60,
  maxFrame = 0.25,
}: { step?: number; maxFrame?: number } = {}) {
  let acc = 0;
  return {
    push(frameSeconds: number, simulate: (dt: number) => void): { steps: number; alpha: number } {
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

export interface LoopMetrics {
  stepsPerSecond: number;
  fps: number;
  frameMs: number;
}

export interface LoopOptions {
  step?: number;
  maxFrame?: number;
  simulate: (dt: number) => void;
  render: (alpha: number, metrics: LoopMetrics) => void;
}

export function createLoop({ step = 1 / 60, simulate, render, maxFrame }: LoopOptions) {
  const accumulator = createAccumulator(
    maxFrame === undefined ? { step } : { step, maxFrame },
  );
  const metrics: LoopMetrics = { stepsPerSecond: 0, fps: 0, frameMs: 0 };

  let rafId: number | null = null;
  let last: number | null = null;
  let windowStart = 0;
  let steps = 0;
  let frames = 0;

  function frame(time: number): void {
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
