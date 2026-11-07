import { DT } from "@dogfight/shared/constants";
import { type LoadResult, loadAll } from "./assets/loader.ts";
import { AudioManager } from "./audio/audio.ts";
import { createInput } from "./input.ts";
import { Lobby } from "./lobby/lobby.ts";
import { createLobbyView } from "./lobby/lobbyView.ts";
import { NetGame, type OutgoingGame } from "./game/netgame.ts";
import type { JoinDetail } from "./lobby/lobby.ts";
import { createLoop } from "./loop.ts";
import { createConnection } from "./net/connection.ts";
import type { CodecName } from "@dogfight/shared/protocol";
import { encode } from "./net/protocol.ts";
import { beginFrame, setupCanvas } from "./render/canvas.ts";
import { drawScene } from "./render/draw.ts";
import type { Controls } from "@dogfight/shared/sim";
import { query } from "./ui/dom.ts";
import { createChatView } from "./ui/chatView.ts";
import { drawNetgraph } from "./ui/netgraph.ts";
import { createNetPanel } from "./ui/netPanel.ts";

const canvas = query(document, "#gameCanvas", HTMLCanvasElement);
const { ctx, size } = setupCanvas(canvas);
const audio = new AudioManager();

// ?sequential — завантажувати ассети по черзі (для порівняння в README).
const SEQUENTIAL = new URLSearchParams(location.search).has("sequential");

function drawCenteredText(
  lines: { text: string; font: string; dy: number }[],
  color = "#58a6ff",
): void {
  beginFrame(ctx, size);
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  lines.forEach(({ text, font, dy }) => {
    ctx.font = font;
    ctx.fillText(text, size.width / 2, size.height / 2 + dy);
  });
}

function drawLoading(done: number, total: number, current: string | null): void {
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
const num = (key: string, fallback: number): number => {
  const value = Number(params.get(key));
  return params.has(key) && Number.isFinite(value) ? value : fallback;
};

const codec: CodecName = params.get("codec") === "json" ? "json" : "binary";
const settings = {
  predict: params.get("predict") !== "0",
  broken: params.get("brokenIntegrate") === "1",
  codec,
  delay: num("delay", 2),
  graph: params.get("netgraph") === "1",
  net: { latency: num("latency", 0), jitter: num("jitter", 0), drop: num("drop", 0) },
};

type Assets = LoadResult<ImageBitmap, AudioBuffer>;

function startGame({ room, playerName }: JoinDetail, assets: Assets): void {
  const chat = createChatView({
    onSend: (text) => conn.send({ type: "chat", text }),
  });
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const conn = createConnection({ url: `${scheme}://${location.host}/ws` });
  const input = createInput(window);

  let game: NetGame | null = null; // створюється, коли сервер відповів "joined"
  let showGraph = settings.graph;
  let net = { ...settings.net };

  // Ігрові повідомлення (бінарні кадри або JSON-текст) — ненадійним каналом
  // без черги; керування (join, chat, net) — із чергою.
  const sendGame = (message: OutgoingGame): void => {
    conn.sendGame(message instanceof Uint8Array ? message : encode(message));
  };

  const panel = createNetPanel({
    initial: { net, predict: settings.predict, delay: settings.delay, graph: showGraph },
    onNet: (value) => {
      net = value;
      conn.send({ type: "net", ...value });
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
    conn.send({ type: "join", room: room.id, name: playerName, codec: settings.codec });
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
    if (net.latency || net.jitter || net.drop) conn.send({ type: "net", ...net });
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
  const readControls = (): Controls => {
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
      turn: right === left ? 0 : right ? 1 : -1,
      fire,
    };
  };

  // Пропускна здатність для netgraph: різниця лічильників раз на секунду.
  const rate = { at: performance.now(), inBytes: 0, outBytes: 0, downKBs: 0, upKBs: 0 };
  const updateRate = (): void => {
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
    get game(): NetGame | null {
      return game;
    },
    conn,
    settings,
  };
}

async function boot(): Promise<void> {
  const abort = new AbortController();
  try {
    audio.unlock();
    drawLoading(0, 1, null);

    const assets = await loadAll("/assets/manifest.json", {
      audioCtx: audio.ctx ?? undefined,
      signal: abort.signal,
      sequential: SEQUENTIAL,
      onProgress: drawLoading,
    });
    console.info(
      `Ассети: ${assets.ms.toFixed(0)} мс (${SEQUENTIAL ? "по черзі" : "паралельно"})`,
    );
    for (const f of assets.failed) {
      const reason = f.error instanceof Error ? f.error.message : String(f.error);
      console.warn(`Не завантажено ${f.key} (${f.url}): ${reason}`);
    }
    audio.setBuffers(assets.sounds);

    const lobby = new Lobby();
    createLobbyView(lobby, {
      onJoin: (joined) => startGame(joined, assets),
    });
  } catch (error: unknown) {
    console.error("Boot failure:", error);
    const reason = error instanceof Error ? error.message : String(error);
    drawCenteredText(
      [{ text: `Помилка запуску: ${reason}`, font: "18px monospace", dy: 0 }],
      "#ff4d4f",
    );
  }
}

drawCenteredText([
  { text: "CLICK ANYWHERE TO START", font: "bold 24px monospace", dy: 0 },
], "#00f0ff");
window.addEventListener("click", boot, { once: true });
