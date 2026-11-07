export interface CanvasSize {
  width: number;
  height: number;
  dpr: number;
}

// Canvas з урахуванням devicePixelRatio. Логічні координати — CSS-пікселі.
export function setupCanvas(canvas: HTMLCanvasElement): {
  ctx: CanvasRenderingContext2D;
  size: CanvasSize;
} {
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("Canvas 2D недоступний");
  const size: CanvasSize = { width: 0, height: 0, dpr: 1 };

  function resize(): void {
    const dpr = window.devicePixelRatio || 1;
    size.width = window.innerWidth;
    size.height = window.innerHeight;
    size.dpr = dpr;

    canvas.width = Math.floor(size.width * dpr);
    canvas.height = Math.floor(size.height * dpr);
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;
  }

  window.addEventListener("resize", resize);
  resize();

  return { ctx, size };
}

// Скидає трансформацію й масштабує під DPR на початку кожного кадру
// (resize скидає стан контексту, тому робити це лише в resize — крихко).
export function beginFrame(
  ctx: CanvasRenderingContext2D,
  size: CanvasSize,
  color = "#0d1117",
): void {
  ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, size.width, size.height);
}
