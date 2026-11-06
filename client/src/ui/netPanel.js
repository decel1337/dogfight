// Панель налаштувань мережі (DOM): латентність/джитер/втрати для ЦЬОГО
// з'єднання (їх застосовує сервер), передбачення, затримка інтерполяції.
const PRESETS = {
  off: { latency: 0, jitter: 0, drop: 0 },
  "100 ms": { latency: 100, jitter: 10, drop: 0 },
  "200 ms": { latency: 200, jitter: 40, drop: 2 },
  "400 ms": { latency: 400, jitter: 100, drop: 5 },
};

export function createNetPanel({
  initial,
  onNet,
  onPredict,
  onDelay,
  onGraph,
}) {
  const root = document.createElement("div");
  root.id = "netPanel";
  root.innerHTML = `
    <style>
      #netPanel{position:fixed;left:12px;bottom:12px;background:rgba(13,17,23,.85);
        color:#e6edf3;font:12px monospace;padding:8px 10px;border:1px solid #30363d;
        border-radius:6px;display:grid;gap:4px;z-index:10}
      #netPanel label{display:flex;justify-content:space-between;gap:8px;align-items:center}
      #netPanel input[type=number]{width:60px;background:#0d1117;color:#e6edf3;border:1px solid #30363d}
      #netPanel select{background:#0d1117;color:#e6edf3;border:1px solid #30363d}
      #netPanel .row{display:flex;gap:4px}
      #netPanel button{background:#21262d;color:#e6edf3;border:1px solid #30363d;cursor:pointer}
    </style>
    <b>Network</b>
    <div class="row">${Object.keys(PRESETS)
      .map((name) => `<button data-preset="${name}">${name}</button>`)
      .join("")}</div>
    <label>latency (RTT) <input id="npLatency" type="number" min="0" max="2000" step="10"></label>
    <label>jitter <input id="npJitter" type="number" min="0" max="1000" step="10"></label>
    <label>drop % <input id="npDrop" type="number" min="0" max="100" step="1"></label>
    <label>prediction <input id="npPredict" type="checkbox"></label>
    <label>interp delay
      <select id="npDelay">${[0, 1, 2, 3, 4, 6]
        .map(
          (n) =>
            `<option value="${n}">${n} ticks (${Math.round((n * 1000) / 30)} ms)</option>`,
        )
        .join("")}</select></label>
    <label>netgraph (F3) <input id="npGraph" type="checkbox"></label>`;
  document.body.append(root);

  const $ = (id) => root.querySelector(id);
  const read = () => ({
    latency: Number($("#npLatency").value) || 0,
    jitter: Number($("#npJitter").value) || 0,
    drop: Number($("#npDrop").value) || 0,
  });
  const write = ({ latency, jitter, drop }) => {
    $("#npLatency").value = latency;
    $("#npJitter").value = jitter;
    $("#npDrop").value = drop;
  };

  write(initial.net);
  $("#npPredict").checked = initial.predict;
  $("#npDelay").value = String(initial.delay);
  $("#npGraph").checked = initial.graph;

  for (const id of ["#npLatency", "#npJitter", "#npDrop"]) {
    $(id).addEventListener("change", () => onNet(read()));
  }
  for (const button of root.querySelectorAll("[data-preset]")) {
    button.addEventListener("click", () => {
      const preset = PRESETS[button.dataset.preset];
      write(preset);
      onNet(preset);
    });
  }
  $("#npPredict").addEventListener("change", (e) =>
    onPredict(e.target.checked),
  );
  $("#npDelay").addEventListener("change", (e) =>
    onDelay(Number(e.target.value)),
  );
  $("#npGraph").addEventListener("change", (e) => onGraph(e.target.checked));

  // Фокус у полях панелі не повинен керувати кораблем, а клавіші гри —
  // змінювати поля: прибираємо фокус після зміни.
  root.addEventListener("change", () => document.activeElement?.blur());

  return {
    root,
    setGraph: (on) => {
      $("#npGraph").checked = on;
    },
  };
}
