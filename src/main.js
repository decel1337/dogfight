import { loadAll } from "./assets/loader.js";
import { AudioManager } from "./audio/audio.js";
import { createInput } from "./input.js";
import { Lobby } from "./lobby/lobby.js";
import { createLobbyView } from "./lobby/lobbyView.js";
import { createLoop } from "./loop.js";
import { beginFrame, setupCanvas } from "./render/canvas.js";
import { drawWorld } from "./render/draw.js";
import { Asteroid, Pickup, Ship } from "./sim/entities.js";
import { World } from "./sim/world.js";

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

function startGame({ room, playerName }, assets) {
  const arena = room.arena ?? assets.arena ?? { width: 1200, height: 800 };
  const world = new World({ arena });

  const ship = world.spawn(
    new Ship(arena.width / 2, arena.height / 2, { name: playerName }),
  );

  for (let i = 0; i < 5; i++) {
    const a = world.rng() * Math.PI * 2;
    const dist = 220 + world.rng() * 220;
    world.spawn(
      new Asteroid(
        arena.width / 2 + Math.cos(a) * dist,
        arena.height / 2 + Math.sin(a) * dist,
        20 + world.rng() * 12,
        { rng: world.rng },
      ),
    );
  }
  world.spawn(new Asteroid(120, 120, 24, { homing: true, rng: world.rng }));
  world.spawn(new Pickup(arena.width * 0.3, arena.height * 0.3, "shield"));
  world.spawn(new Pickup(arena.width * 0.7, arena.height * 0.7, "rapid"));

  // Звук підписується на події симуляції; симуляція про звук нічого не знає.
  audio.listenTo(world.events);

  const input = createInput(window);

  // Баг із this (Lab 02): addEventListener("click", ship.fire) втратив би
  // this. Обраний фікс — стрілка, що лексично зберігає ship.
  window.addEventListener("click", () => ship.fire(world));

  const loop = createLoop({
    step: 1 / 60,
    simulate: (dt) => {
      world.step(dt, input);
      input.endStep();
    },
    render: (alpha, metrics) => {
      drawWorld(ctx, size, world, alpha, {
        ship,
        metrics,
        images: assets.images,
      });
    },
  });
  loop.start();
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
      [{ text: `Помилка запуску: ${error.message}`, font: "18px monospace", dy: 0 }],
      "#ff4d4f",
    );
  }
}

drawCenteredText([
  { text: "CLICK ANYWHERE TO START", font: "bold 24px monospace", dy: 0 },
], "#00f0ff");
window.addEventListener("click", boot, { once: true });
