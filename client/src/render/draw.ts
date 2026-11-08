import type { EntityRecord } from "@dogfight/shared/sim";
import { assertNever } from "@dogfight/shared/types";
import type { Effect, Scene } from "../game/netgame.ts";
import { type CanvasSize, beginFrame } from "./canvas.ts";
import { type SpriteSheet, drawFrame } from "./sprites.ts";

export interface DrawImages {
  ship?: SpriteSheet | undefined;
  asteroid?: SpriteSheet | undefined;
}

export interface HudMetrics {
  stepsPerSecond: number | string;
  fps: number | string;
}

// Те, що вміє малювати drawRecord: запис снапшота (поля a/b/c потрібні лише
// деяким видам) і необов'язковий прапорець тяги від передбачення.
type Drawable = Pick<EntityRecord, "kind" | "flags" | "x" | "y" | "angle"> &
  Partial<Pick<EntityRecord, "a">> & { thrusting?: boolean | undefined };

// Біти flags кораблів і куль зі снапшота (див. специфікацію протоколу).
const THRUST = 1;
const SHIELD = 2;
const DEAD = 4;
const INVULNERABLE = 8;
const RAPID = 16;
const HOMING = 1;

const SHIP_SIZE = 44;
const PICKUP_COLORS = ["#58a6ff", "#3fb950"]; // shield, rapid

function drawShip(
  ctx: CanvasRenderingContext2D,
  ship: Drawable,
  { sprite, mine, thrusting }: { sprite: SpriteSheet | undefined; mine: boolean; thrusting: boolean },
): void {
  if (sprite) {
    drawFrame(ctx, sprite, thrusting ? 1 : 0, SHIP_SIZE);
  } else {
    ctx.beginPath();
    ctx.moveTo(20, 0);
    ctx.lineTo(-15, -12);
    ctx.lineTo(-8, 0);
    ctx.lineTo(-15, 12);
    ctx.closePath();
    ctx.fillStyle = mine ? "#00f0ff" : "#ff9f43";
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.stroke();
    if (thrusting) {
      ctx.beginPath();
      ctx.moveTo(-10, -5);
      ctx.lineTo(-22, 0);
      ctx.lineTo(-10, 5);
      ctx.strokeStyle = "#ff7b00";
      ctx.stroke();
    }
  }
  if (ship.flags & SHIELD) {
    ctx.beginPath();
    ctx.arc(0, 0, 22, 0, Math.PI * 2);
    ctx.strokeStyle = "#58a6ff";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

// Кулі малюємо ПАКЕТОМ: один path на колір і один fill замість
// save/translate/arc/fill/restore на кожну кулю. Менше викликів canvas =
// менший буфер записаних команд (він рахується як зовнішня пам'ять і
// підганяв V8 до major GC — див. README, Lab 07 / M3).
const BULLET_COLORS = ["#ff3860", "#ffd33d"] as const; // звичайна, самонавідна
const TAU = Math.PI * 2;

function drawBullets(ctx: CanvasRenderingContext2D, scene: Scene): void {
  for (let color = 0; color < 2; color++) {
    ctx.beginPath();
    for (const e of scene.entities) {
      if (e.kind !== 2 || ((e.flags & HOMING) !== 0) !== (color === 1)) continue;
      ctx.moveTo(e.x + 3, e.y);
      ctx.arc(e.x, e.y, 3, 0, TAU);
    }
    if (color === 0) {
      for (const b of scene.localBullets) {
        ctx.moveTo(b.x + 3, b.y);
        ctx.arc(b.x, b.y, 3, 0, TAU);
      }
    }
    ctx.fillStyle = BULLET_COLORS[color] ?? "#ffffff";
    ctx.fill();
  }
}

function drawRecord(
  ctx: CanvasRenderingContext2D,
  e: Drawable,
  images: DrawImages,
  mine = false,
): void {
  ctx.save();
  ctx.translate(e.x, e.y);
  switch (e.kind) {
    case 1: {
      if (e.flags & DEAD) break;
      ctx.rotate(e.angle);
      if (e.flags & INVULNERABLE) ctx.globalAlpha = 0.45;
      const thrusting = e.thrusting ?? (e.flags & THRUST) !== 0;
      drawShip(ctx, e, { sprite: images.ship, mine, thrusting });
      break;
    }
    case 2:
      ctx.beginPath();
      ctx.arc(0, 0, 3, 0, Math.PI * 2);
      ctx.fillStyle = e.flags & HOMING ? "#ffd33d" : "#ff3860";
      ctx.fill();
      break;
    case 3: {
      const homing = (e.flags & HOMING) !== 0;
      if (images.asteroid && !homing) {
        ctx.rotate(e.angle);
        drawFrame(ctx, images.asteroid, 0, (e.a ?? 0) * 2);
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, e.a ?? 0, 0, Math.PI * 2);
        ctx.strokeStyle = homing ? "#f85149" : "#8b949e";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      break;
    }
    case 4:
      ctx.beginPath();
      ctx.arc(0, 0, 10, 0, Math.PI * 2);
      ctx.strokeStyle = PICKUP_COLORS[e.a ?? 0] ?? "#ffffff";
      ctx.lineWidth = 3;
      ctx.stroke();
      break;
    default:
      assertNever(e.kind, "вид сутності");
  }
  ctx.restore();
}

function drawEffect(ctx: CanvasRenderingContext2D, effect: Effect): void {
  ctx.save();
  if (effect.type === "explosion") {
    const t = effect.age / 0.6;
    ctx.globalAlpha = Math.max(0, 1 - t);
    ctx.fillStyle = "#ffa657";
    for (const p of effect.particles) {
      const d = p.speed * effect.age;
      ctx.fillRect(
        effect.x + Math.cos(p.angle) * d - 1.5,
        effect.y + Math.sin(p.angle) * d - 1.5,
        3,
        3,
      );
    }
  } else {
    ctx.globalAlpha = Math.max(0, 1 - effect.age / 0.6);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(effect.x, effect.y, 6 + effect.age * 40, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

// Рядки HUD міняються рідко (FPS — двічі на секунду, рахунок — по події), а
// шаблонні рядки + масив + forEach-замикання щокадру були помітним алокатором.
// Тому ключ із чисел кешує готові рядки; перебудова — лише коли ключ змінився.
const hud = {
  steps: "" as number | string,
  fps: "" as number | string,
  count: -1,
  has: false,
  score: -1,
  hp: -1,
  flags: -1,
  lines: [] as string[],
  dead: "",
  deadKey: -1,
};

function hudLines(scene: Scene, metrics: HudMetrics): string[] {
  const me = scene.me;
  const count = scene.entities.length + (me ? 1 : 0);
  const flags = me ? me.flags & (SHIELD | RAPID) : 0;
  const score = me ? me.c : -1;
  const hp = me ? me.a : -1;
  if (
    metrics.stepsPerSecond !== hud.steps || metrics.fps !== hud.fps || count !== hud.count ||
    Boolean(me) !== hud.has || score !== hud.score || hp !== hud.hp || flags !== hud.flags
  ) {
    hud.steps = metrics.stepsPerSecond;
    hud.fps = metrics.fps;
    hud.count = count;
    hud.has = Boolean(me);
    hud.score = score;
    hud.hp = hp;
    hud.flags = flags;
    hud.lines = [`Steps/s: ${metrics.stepsPerSecond}`, `FPS: ${metrics.fps}`, `Entities: ${count}`];
    if (me) {
      hud.lines.push(
        `Score: ${me.c}`,
        `HP: ${me.a}/3${me.flags & SHIELD ? "  [SHIELD]" : ""}${me.flags & RAPID ? "  [RAPID]" : ""}`,
      );
    }
  }
  return hud.lines;
}

function drawHud(
  ctx: CanvasRenderingContext2D,
  size: CanvasSize,
  scene: Scene,
  metrics: HudMetrics,
): void {
  const me = scene.me;
  ctx.save();
  ctx.font = "14px monospace";
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "left";
  const lines = hudLines(scene, metrics);
  for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i] ?? "", 20, 30 + i * 20);

  if (me && me.flags & DEAD) {
    ctx.textAlign = "center";
    ctx.font = "bold 24px monospace";
    ctx.fillStyle = "#f85149";
    const seconds = Math.round(me.b / 3); // десяті частки секунди (me.b — тики при 30 Гц)
    if (seconds !== hud.deadKey) {
      hud.deadKey = seconds;
      hud.dead = `DESTROYED — respawn in ${(me.b / 30).toFixed(1)}s`;
    }
    ctx.fillText(hud.dead, size.width / 2, size.height / 2);
  }
  ctx.restore();
}

// Малюємо СЦЕНУ (плоскі записи зі снапшотів), а не об'єкти симуляції: у
// клієнта більше немає власного світу, лише те, що сказав сервер.
// Результат drawScene — один спільний об'єкт (дійсний до наступного виклику).
const view = { scale: 1, offsetX: 0, offsetY: 0 };

export function drawScene(
  ctx: CanvasRenderingContext2D,
  size: CanvasSize,
  scene: Scene,
  { metrics, images }: { metrics: HudMetrics; images: DrawImages },
): { scale: number; offsetX: number; offsetY: number } {
  beginFrame(ctx, size);

  const { width, height } = scene.arena;
  const scale = Math.min(size.width / width, size.height / height);
  const offsetX = (size.width - width * scale) / 2;
  const offsetY = (size.height - height * scale) / 2;

  ctx.save();
  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);

  ctx.strokeStyle = "#30363d";
  ctx.lineWidth = 2;
  ctx.strokeRect(0, 0, width, height);
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.clip();

  for (const e of scene.entities) if (e.kind !== 2) drawRecord(ctx, e, images);
  drawBullets(ctx, scene);
  if (scene.me) drawRecord(ctx, scene.me, images, true);
  for (const effect of scene.effects) drawEffect(ctx, effect);
  ctx.restore();

  drawHud(ctx, size, scene, metrics);
  view.scale = scale;
  view.offsetX = offsetX;
  view.offsetY = offsetY;
  return view;
}
