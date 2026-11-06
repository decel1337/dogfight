import { DT } from "@dogfight/shared/constants";
import { loadAll } from "./assets/loader.js";
import { AudioManager } from "./audio/audio.js";
import { createInput } from "./input.js";
import { Lobby } from "./lobby/lobby.js";
import { createLobbyView } from "./lobby/lobbyView.js";
import { NetGame } from "./game/netgame.js";
import { createLoop } from "./loop.js";
import { createConnection } from "./net/connection.js";
import { encode } from "./net/protocol.js";
import { beginFrame, setupCanvas } from "./render/canvas.js";
import { drawScene } from "./render/draw.js";
import { createChatView } from "./ui/chatView.js";
import { drawNetgraph } from "./ui/netgraph.js";
import { createNetPanel } from "./ui/netPanel.js";

const canvas = document.querySelector("#gameCanvas");
const { ctx, size } = setupCanvas(canvas);
const audio = new AudioManager();

// ?sequential — завантажувати ассети по черзі (для порівняння в README).
const SEQUENTIAL = new URLSearchParams(location.search).has("sequential");

function drawCenteredText(lines, color = "#58a6ff") {
  beginFrame(ctx, size);
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  lines.forEach(({ text, font, dy }) => {
    ctx.font = font;
    ctx.fillText(text, size.width / 2, size.height / 2 + dy);
  });
}

function drawLoading(done, total, current) {
  drawCenteredText([
    {
      text: `LOADING ASSETS: ${done}/${total}${current ? ` (${current})` : ""}`,
      font: "20px monospace",
      dy: -25,
    },
  ]);
  const barW = 320;
  const barH = 22;
  const x = (size.width - barW) / 2;
  const y = size.height / 2;
  const pct = total === 0 ? 0 : done / total;
  ctx.strokeStyle = "#30363d";
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, barW, barH);
  ctx.fillRect(x + 2, y + 2, (barW - 4) * pct, barH - 4);
}

// Параметри з адресного рядка: ?predict=0 (M1: без передбачення),
// ?brokenIntegrate=1 (integrate з Math.random), ?codec=json, ?latency=200
// &jitter=40&drop=2 (імітація мережі), ?delay=2 (тики інтерполяції),
// ?netgraph=1.
const params = new URLSearchParams(location.search);
const num = (key, fallback) => {
  const value = Number(params.get(key));
  return params.has(key) && Number.isFinite(value) ? value : fallback;
};

const settings = {
  predict: params.get("predict") !== "0",
  broken: params.get("brokenIntegrate") === "1",
  codec: params.get("codec") === "json" ? "json" : "binary",
  delay: num("delay", 2),
  graph: params.get("netgraph") === "1",
  net: {
    latency: num("latency", 0),
    jitter: num("jitter", 0),
    drop: num("drop", 0),
  },
};

function startGame({ room, playerName }, assets) {
  const chat = createChatView({
    onSend: (text) => conn.send("chat", { text }),
  });
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const conn = createConnection({ url: `${scheme}://${location.host}/ws` });
  const input = createInput(window);

  let game = null; // створюється, коли сервер відповів "joined"
  let showGraph = settings.graph;
  let net = { ...settings.net };

  // Ігрові повідомлення (бінарні кадри або JSON-текст) — ненадійним каналом
  // без черги; керування (join, chat, net) — із чергою.
  const sendGame = (message) => {
    if (message instanceof Uint8Array) conn.sendGame(message);
    else {
      const { type, ...rest } = message;
      conn.sendGame(encode(type, rest));
    }
  };

  const panel = createNetPanel({
    initial: {
      net,
      predict: settings.predict,
      delay: settings.delay,
      graph: showGraph,
    },
    onNet: (value) => {
      net = value;
      conn.send("net", value);
    },
    onPredict: (on) => {
      settings.predict = on;
      game?.setOption("predict", on);
    },
    onDelay: (ticks) => {
      settings.delay = ticks;
      if (game) game.options.interpolationDelayTicks = ticks;
    },
    onGraph: (on) => {
      showGraph = on;
    },
  });
  window.addEventListener("keydown", (event) => {
    if (event.code !== "F3") return;
    event.preventDefault();
    showGraph = !showGraph;
    panel.setGraph(showGraph);
  });

  // Після кожного (пере)підключення сервер нас не пам'ятає — представляємось знову.
  conn.on("open", () => {
    chat.setStatus("Підключено");
    conn.send("join", {
      room: room.id,
      name: playerName,
      codec: settings.codec,
    });
  });
  conn.on("joined", (msg) => {
    chat.addSystem(`Ви в кімнаті «${msg.room.name}»`);
    game = new NetGame({
      joined: msg,
      send: sendGame,
      play: (name) => audio.play(name),
      options: {
        predict: settings.predict,
        broken: settings.broken,
        interpolationDelayTicks: settings.delay,
      },
    });
    if (net.latency || net.jitter || net.drop) conn.send("net", net);
  });
  conn.on("snapshot", (msg) => game?.onSnapshot(msg));
  conn.on("events", (msg) => game?.onEvents(msg));
  conn.on("pong", (msg) => game?.onPong(msg));
  conn.on("roster", (msg) => chat.setRoster(msg.players));
  conn.on("chat", (msg) => chat.addMessage(msg));
  conn.on("error", (msg) => chat.addSystem(`Сервер: ${msg.message}`));
  conn.on("reconnecting", ({ attempt, delayMs }) => {
    game = null;
    chat.setStatus(`Зв'язок втрачено. Спроба ${attempt} через ${delayMs} мс`);
  });
  conn.on("close", ({ code, willRetry }) => {
    if (!willRetry) {
      game = null;
      chat.setStatus(`Відключено (код ${code})`);
    }
  });
  conn.connect();

  setInterval(() => game?.ping(), 500);

  // Клік по canvas — постріл (панель чату й налаштувань не стріляє).
  let clickFire = false;
  canvas.addEventListener("click", () => {
    clickFire = true;
  });

  // Один крок симуляції клієнта = один input на сервер (30 Гц).
  const readControls = () => {
    const left = input.isDown("ArrowLeft") || input.isDown("KeyA");
    const right = input.isDown("ArrowRight") || input.isDown("KeyD");
    const fire = input.justPressed("KeyH")
      ? 2
      : input.isDown("Space") || clickFire
        ? 1
        : 0;
    clickFire = false;
    return {
      thrust: input.isDown("ArrowUp") || input.isDown("KeyW") ? 1 : 0,
      turn: (right ? 1 : 0) - (left ? 1 : 0),
      fire,
    };
  };

  // Пропускна здатність для netgraph: різниця лічильників раз на секунду.
  const rate = {
    at: performance.now(),
    inBytes: 0,
    outBytes: 0,
    downKBs: 0,
    upKBs: 0,
  };
  const updateRate = () => {
    const now = performance.now();
    if (now - rate.at < 1000) return;
    const seconds = (now - rate.at) / 1000;
    rate.downKBs = (conn.stats.bytesIn - rate.inBytes) / 1024 / seconds;
    rate.upKBs = (conn.stats.bytesOut - rate.outBytes) / 1024 / seconds;
    rate.inBytes = conn.stats.bytesIn;
    rate.outBytes = conn.stats.bytesOut;
    rate.at = now;
  };

  let lastFrame = performance.now();
  const loop = createLoop({
    step: DT,
    simulate: () => {
      if (game?.ready) game.step(readControls());
      input.endStep();
    },
    render: (alpha, metrics) => {
      const now = performance.now();
      const frameSeconds = (now - lastFrame) / 1000;
      lastFrame = now;

      if (!game?.ready) {
        drawCenteredText([
          { text: "Connecting…", font: "20px monospace", dy: 0 },
        ]);
        return;
      }
      drawScene(ctx, size, game.scene(alpha, frameSeconds), {
        metrics,
        images: assets.images,
      });
      if (showGraph) {
        updateRate();
        drawNetgraph(ctx, size, game.netStats(), rate);
      }
    },
  });
  loop.start();

  // Для тестів і діагностики з консолі браузера (window.__dogfight).
  window.__dogfight = {
    get game() {
      return game;
    },
    conn,
    settings,
  };
}

async function boot() {
  const abort = new AbortController();
  try {
    audio.unlock();
    drawLoading(0, 1, null);

    const assets = await loadAll("/assets/manifest.json", {
      audioCtx: audio.ctx,
      signal: abort.signal,
      sequential: SEQUENTIAL,
      onProgress: drawLoading,
    });
    console.info(
      `Ассети: ${assets.ms.toFixed(0)} мс (${SEQUENTIAL ? "по черзі" : "паралельно"})`,
    );
    for (const f of assets.failed) {
      console.warn(`Не завантажено ${f.key} (${f.url}): ${f.error.message}`);
    }
    audio.setBuffers(assets.sounds);

    const lobby = new Lobby();
    createLobbyView(lobby, {
      onJoin: (joined) => startGame(joined, assets),
    });
  } catch (error) {
    console.error("Boot failure:", error);
    drawCenteredText(
      [
        {
          text: `Помилка запуску: ${error.message}`,
          font: "18px monospace",
          dy: 0,
        },
      ],
      "#ff4d4f",
    );
  }
}

drawCenteredText(
  [{ text: "CLICK ANYWHERE TO START", font: "bold 24px monospace", dy: 0 }],
  "#00f0ff",
);
window.addEventListener("click", boot, { once: true });
