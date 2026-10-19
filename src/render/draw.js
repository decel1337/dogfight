import { lerpAngle } from "../sim/vector.js";
import { beginFrame } from "./canvas.js";
import { drawFrame } from "./sprites.js";

// Стан для малювання = інтерполяція між попереднім і поточним кроком.
function renderState(entity, alpha) {
  const pos = entity.prevPos.lerp(entity.pos, alpha);
  const angle = lerpAngle(entity.prevAngle, entity.angle, alpha);
  return { pos, angle };
}

function drawShip(ctx, ship, sprite) {
  if (sprite) {
    drawFrame(ctx, sprite, ship.thrusting ? 1 : 0, 44);
    return;
  }
  ctx.beginPath();
  ctx.moveTo(20, 0);
  ctx.lineTo(-15, -12);
  ctx.lineTo(-8, 0);
  ctx.lineTo(-15, 12);
  ctx.closePath();
  ctx.fillStyle = "#00f0ff";
  ctx.fill();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2;
  ctx.stroke();

  if (ship.thrusting) {
    ctx.beginPath();
    ctx.moveTo(-10, -5);
    ctx.lineTo(-22, 0);
    ctx.lineTo(-10, 5);
    ctx.strokeStyle = "#ff7b00";
    ctx.stroke();
  }
}

function drawEntity(ctx, entity, alpha, images) {
  const { pos, angle } = renderState(entity, alpha);
  ctx.save();
  ctx.translate(pos.x, pos.y);

  switch (entity.kind) {
    case "ship": {
      if (entity.dead) break;
      ctx.rotate(angle);
      // Блимання під час невразливості після респавну.
      if (entity.invulnerable > 0 && Math.floor(entity.invulnerable * 10) % 2) {
        ctx.globalAlpha = 0.35;
      }
      drawShip(ctx, entity, images.ship);
      if (entity.shield) {
        ctx.beginPath();
        ctx.arc(0, 0, entity.radius + 8, 0, Math.PI * 2);
        ctx.strokeStyle = "#58a6ff";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      break;
    }
    case "bullet": {
      ctx.beginPath();
      ctx.arc(0, 0, entity.radius, 0, Math.PI * 2);
      ctx.fillStyle = entity.behaviors.length > 0 ? "#ffd33d" : "#ff3860";
      ctx.fill();
      break;
    }
    case "asteroid": {
      const sprite = images.asteroid;
      if (sprite) {
        ctx.rotate(angle);
        drawFrame(ctx, sprite, 0, entity.radius * 2);
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, entity.radius, 0, Math.PI * 2);
        ctx.strokeStyle = entity.behaviors.length > 0 ? "#f85149" : "#8b949e";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      break;
    }
    case "pickup": {
      ctx.beginPath();
      ctx.arc(0, 0, entity.radius, 0, Math.PI * 2);
      ctx.strokeStyle = entity.type === "shield" ? "#58a6ff" : "#3fb950";
      ctx.lineWidth = 3;
      ctx.stroke();
      break;
    }
    case "explosion": {
      ctx.translate(-pos.x, -pos.y);
      ctx.fillStyle = "#ffa657";
      ctx.globalAlpha = Math.max(0, entity.ttl / 0.6);
      for (const p of entity.particles) {
        ctx.fillRect(p.pos.x - 1.5, p.pos.y - 1.5, 3, 3);
      }
      break;
    }
    default:
      break;
  }
  ctx.restore();
}

function drawHud(ctx, { ship, metrics, world, size }) {
  ctx.save();
  ctx.font = "14px monospace";
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "left";

  const lines = [
    `Steps/s: ${metrics.stepsPerSecond}`,
    `FPS: ${metrics.fps}`,
    `Frame: ${metrics.frameMs.toFixed(1)} ms`,
    `Entities: ${world.size}`,
    `Score: ${ship.score}`,
    `HP: ${ship.hp}/3${ship.shield ? "  [SHIELD]" : ""}${
      ship.rapidTimer > 0 ? `  [RAPID ${ship.rapidTimer.toFixed(1)}s]` : ""
    }`,
  ];
  lines.forEach((text, i) => {
    ctx.fillText(text, 20, 30 + i * 20);
  });

  if (ship.dead) {
    ctx.textAlign = "center";
    ctx.font = "bold 24px monospace";
    ctx.fillStyle = "#f85149";
    ctx.fillText(
      `DESTROYED — respawn in ${ship.respawnTimer.toFixed(1)}s`,
      size.width / 2,
      size.height / 2,
    );
  }
  ctx.restore();
}

// Арена вписується у вікно зі збереженням пропорцій (розмір арени
// береться з кімнати/маніфесту і може не збігатися з вікном).
export function drawWorld(ctx, size, world, alpha, hud) {
  beginFrame(ctx, size);

  const { width, height } = world.arena;
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

  for (const entity of world) {
    if (entity.alive) drawEntity(ctx, entity, alpha, hud.images);
  }
  ctx.restore();

  drawHud(ctx, { ...hud, world, size });
}
