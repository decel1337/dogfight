// Canvas з урахуванням devicePixelRatio. Логічні координати — CSS-пікселі.
export function setupCanvas(canvas) {
  const ctx = canvas.getContext("2d");
  const size = { width: 0, height: 0, dpr: 1 };

  function resize() {
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
export function beginFrame(ctx, size, color = "#0d1117") {
  ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, size.width, size.height);
}
