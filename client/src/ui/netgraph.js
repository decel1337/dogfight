// Netgraph: наочна діагностика мережі, намальована прямо на canvas.
//  зверху — інтервали між снапшотами (мс), ідеал ≈ 33;
//  знизу  — розмір поправки реконсиляції (px) на кожен снапшот;
//  текст  — RTT, джитер, втрати, режим буфера, затримка інтерполяції.
function sparkline(ctx, values, { x, y, w, h, max, color, label }) {
  ctx.strokeStyle = "#30363d";
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = "#8b949e";
  ctx.fillText(`${label} (max ${max})`, x + 4, y - 4);
  if (values.length < 2) return;

  ctx.beginPath();
  values.forEach((v, i) => {
    const px = x + (i / (values.length - 1)) * w;
    const py = y + h - Math.min(1, v / max) * h;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

export function drawNetgraph(ctx, size, stats, extra = {}) {
  const w = 220;
  const x = size.width - w - 16;
  let y = 24;

  ctx.save();
  ctx.font = "12px monospace";
  ctx.textAlign = "left";
  ctx.fillStyle = "rgba(13,17,23,0.78)";
  ctx.fillRect(x - 8, 8, w + 16, 330);

  const mode = stats.mode;
  const modeColor = mode === "interpolating" ? "#3fb950" : "#f85149";
  const rows = [
    ["RTT", `${stats.rttMs.toFixed(0)} ms (±${stats.jitterMs.toFixed(0)})`],
    ["Snapshots", `${stats.snapshotHz.toFixed(1)} /s`],
    ["Loss", `${stats.lossPct.toFixed(1)} %`],
    ["Interp delay", `${stats.interpolationDelayMs.toFixed(0)} ms`],
    ["Buffer", `${stats.bufferSnapshots} snaps`],
    ["Predict", stats.predict ? "ON" : "OFF"],
    ["Pending inp", `${stats.pendingInputs}`],
    ["Correction", `${stats.correctionPx.toFixed(2)} px`],
    ["Codec", stats.codec],
    [
      "↓ / ↑",
      `${(extra.downKBs ?? 0).toFixed(1)} / ${(extra.upKBs ?? 0).toFixed(1)} KB/s`,
    ],
  ];
  for (const [name, value] of rows) {
    ctx.fillStyle = "#8b949e";
    ctx.fillText(name, x, y);
    ctx.fillStyle = "#e6edf3";
    ctx.fillText(value, x + 110, y);
    y += 16;
  }
  ctx.fillStyle = "#8b949e";
  ctx.fillText("Remote", x, y);
  ctx.fillStyle = modeColor;
  ctx.fillText(mode, x + 110, y);
  y += 28;

  sparkline(ctx, stats.arrivals, {
    x,
    y,
    w,
    h: 50,
    max: 100,
    color: "#58a6ff",
    label: "snapshot interval ms",
  });
  y += 78;
  sparkline(ctx, stats.corrections, {
    x,
    y,
    w,
    h: 50,
    max: 20,
    color: "#ffa657",
    label: "correction px",
  });
  ctx.restore();
}
