export function setupCanvas(canvas) {
  const ctx = canvas.getContext("2d");

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const width = window.innerWidth;
    const height = window.innerHeight;

    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    ctx.resetTransform?.();
    ctx.scale(dpr, dpr);
  }

  window.addEventListener("resize", resize);
  resize();

  return {
    ctx,
    getLogicalSize: () => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }),
  };
}
