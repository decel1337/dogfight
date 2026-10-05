import { Explosion } from "./entities.js";

export function checkCollisions(world) {
  const entities = Array.from(world);

  for (let i = 0; i < entities.length; i++) {
    const a = entities[i];
    if (!a.alive) continue;

    for (let j = i + 1; j < entities.length; j++) {
      const b = entities[j];
      if (!b.alive) continue;

      const dist = a.pos.dist(b.pos);
      if (dist < a.radius + b.radius) {
        resolveCollision(a, b, world);
      }
    }
  }
}

function resolveCollision(a, b, world) {
  // Куля влучає в астероїд
  if (
    (a.kind === "bullet" && b.kind === "asteroid") ||
    (a.kind === "asteroid" && b.kind === "bullet")
  ) {
    const bullet = a.kind === "bullet" ? a : b;
    const asteroid = a.kind === "asteroid" ? a : b;
    bullet.alive = false;
    asteroid.alive = false;
    world.spawn(new Explosion(asteroid.pos.x, asteroid.pos.y));

    // Нараховуємо очки кораблю
    for (const ship of world.ofKind("ship")) {
      ship.score += 100;
    }
  }

  // Корабель врізається в астероїд
  if (
    (a.kind === "ship" && b.kind === "asteroid") ||
    (a.kind === "asteroid" && b.kind === "ship")
  ) {
    const ship = a.kind === "ship" ? a : b;
    const asteroid = a.kind === "asteroid" ? a : b;
    if (ship.alive) {
      ship.damage(1);
      asteroid.alive = false;
      world.spawn(new Explosion(ship.pos.x, ship.pos.y));
    }
  }

  // Корабель підбирає бонус
  if (
    (a.kind === "ship" && b.kind === "pickup") ||
    (a.kind === "pickup" && b.kind === "ship")
  ) {
    const ship = a.kind === "ship" ? a : b;
    const pickup = a.kind === "pickup" ? a : b;
    if (ship.alive) {
      pickup.applyTo(ship);
    }
  }
}
