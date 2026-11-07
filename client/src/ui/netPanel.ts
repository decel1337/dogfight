// Панель налаштувань мережі (DOM): латентність/джитер/втрати для ЦЬОГО
// з'єднання (їх застосовує сервер), передбачення, затримка інтерполяції.
import { query, queryAll } from "./dom.ts";

export interface NetSettings {
  latency: number;
  jitter: number;
  drop: number;
}

const PRESETS: Record<string, NetSettings> = {
  off: { latency: 0, jitter: 0, drop: 0 },
  "100 ms": { latency: 100, jitter: 10, drop: 0 },
  "200 ms": { latency: 200, jitter: 40, drop: 2 },
  "400 ms": { latency: 400, jitter: 100, drop: 5 },
};

export interface NetPanelOptions {
  initial: { net: NetSettings; predict: boolean; delay: number; graph: boolean };
  onNet: (settings: NetSettings) => void;
  onPredict: (on: boolean) => void;
  onDelay: (ticks: number) => void;
  onGraph: (on: boolean) => void;
}

export function createNetPanel({
  initial,
  onNet,
  onPredict,
  onDelay,
  onGraph,
}: NetPanelOptions): { root: HTMLDivElement; setGraph(on: boolean): void } {
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
        .map((n) => `<option value="${n}">${n} ticks (${Math.round((n * 1000) / 30)} ms)</option>`)
        .join("")}</select></label>
    <label>netgraph (F3) <input id="npGraph" type="checkbox"></label>`;
  document.body.append(root);

  const latency = query(root, "#npLatency", HTMLInputElement);
  const jitter = query(root, "#npJitter", HTMLInputElement);
  const drop = query(root, "#npDrop", HTMLInputElement);
  const predict = query(root, "#npPredict", HTMLInputElement);
  const delay = query(root, "#npDelay", HTMLSelectElement);
  const graph = query(root, "#npGraph", HTMLInputElement);

  const read = (): NetSettings => ({
    latency: Number(latency.value) || 0,
    jitter: Number(jitter.value) || 0,
    drop: Number(drop.value) || 0,
  });
  const write = (settings: NetSettings): void => {
    latency.value = String(settings.latency);
    jitter.value = String(settings.jitter);
    drop.value = String(settings.drop);
  };

  write(initial.net);
  predict.checked = initial.predict;
  delay.value = String(initial.delay);
  graph.checked = initial.graph;

  for (const input of [latency, jitter, drop]) {
    input.addEventListener("change", () => onNet(read()));
  }
  for (const button of queryAll(root, "[data-preset]", HTMLButtonElement)) {
    button.addEventListener("click", () => {
      const preset = PRESETS[button.dataset.preset ?? ""];
      if (!preset) return;
      write(preset);
      onNet(preset);
    });
  }
  predict.addEventListener("change", () => onPredict(predict.checked));
  delay.addEventListener("change", () => onDelay(Number(delay.value)));
  graph.addEventListener("change", () => onGraph(graph.checked));

  // Фокус у полях панелі не повинен керувати кораблем, а клавіші гри —
  // змінювати поля: прибираємо фокус після зміни.
  root.addEventListener("change", () => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });

  return {
    root,
    setGraph: (on: boolean) => {
      graph.checked = on;
    },
  };
}
