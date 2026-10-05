export function drawWorld(ctx, world, stats, _alpha) {
  for (const entity of world) {
    if (!entity.alive && entity.kind !== "explosion") continue;

    ctx.save();
    ctx.translate(entity.pos.x, entity.pos.y);

    if (entity.kind === "ship") {
      drawShip(ctx, entity);
    } else if (entity.kind === "bullet") {
      drawBullet(ctx, entity);
    } else if (entity.kind === "asteroid") {
      drawAsteroid(ctx, entity);
    } else if (entity.kind === "pickup") {
      drawPickup(ctx, entity);
    } else if (entity.kind === "explosion") {
      drawExplosion(ctx, entity);
    }

    ctx.restore();
  }

  drawHud(ctx, stats, world);
}

function drawShip(ctx, ship) {
  ctx.rotate(ship.angle);
  ctx.beginPath();
  ctx.moveTo(16, 0);
  ctx.lineTo(-12, -10);
  ctx.lineTo(-6, 0);
  ctx.lineTo(-12, 10);
  ctx.closePath();
  ctx.fillStyle = ship.hp > 1 ? "#38bdf8" : "#ef4444";
  ctx.fill();
  ctx.strokeStyle = "#e0f2fe";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  if (ship.thrusting) {
    ctx.beginPath();
    ctx.moveTo(-7, 0);
    ctx.lineTo(-18, -4);
    ctx.lineTo(-24, 0);
    ctx.lineTo(-18, 4);
    ctx.closePath();
    ctx.fillStyle = "#f97316";
    ctx.fill();
  }
}

function drawBullet(ctx, bullet) {
  ctx.beginPath();
  ctx.arc(0, 0, bullet.radius, 0, Math.PI * 2);
  ctx.fillStyle = bullet.homing ? "#a855f7" : "#fde047";
  ctx.fill();
}

function drawAsteroid(ctx, asteroid) {
  ctx.beginPath();
  ctx.arc(0, 0, asteroid.radius, 0, Math.PI * 2);
  ctx.fillStyle = asteroid.homing ? "#7c2d12" : "#475569";
  ctx.fill();
  ctx.strokeStyle = "#94a3b8";
  ctx.stroke();
}

function drawPickup(ctx, pickup) {
  ctx.beginPath();
  ctx.rect(-7, -7, 14, 14);
  ctx.fillStyle = pickup.type === "shield" ? "#38bdf8" : "#22c55e";
  ctx.fill();
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();
}

function drawExplosion(ctx, explosion) {
  for (const p of explosion.particles) {
    if (p.life <= 0) continue;
    ctx.beginPath();
    ctx.arc(
      p.pos.x - explosion.pos.x,
      p.pos.y - explosion.pos.y,
      2,
      0,
      Math.PI * 2,
    );
    ctx.fillStyle = `rgba(249, 115, 22, ${p.life / 0.6})`;
    ctx.fill();
  }
}

function drawHud(ctx, { fps, sps, frameTime }, world) {
  let ship = null;
  for (const s of world.ofKind("ship")) {
    ship = s;
    break;
  }

  ctx.save();
  ctx.font = "14px monospace";
  ctx.fillStyle = "#a1a1aa";
  ctx.fillText(
    `FPS: ${fps} | SPS: ${sps} | ${frameTime.toFixed(2)} ms`,
    16,
    26,
  );

  if (ship) {
    ctx.fillStyle = "#38bdf8";
    ctx.fillText(`Score: ${ship.score}`, 16, 48);
    ctx.fillStyle = ship.hp > 0 ? "#22c55e" : "#ef4444";
    const hpText = ship.alive
      ? "♥".repeat(ship.hp)
      : `RESPAWN IN ${ship.respawnTimer.toFixed(1)}s`;
    ctx.fillText(`HP: ${hpText}`, 16, 70);
  }
  ctx.restore();
}
