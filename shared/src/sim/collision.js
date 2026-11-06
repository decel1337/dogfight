import { DAMAGE } from "./entities.js";
import { SCORE } from "../constants.js";
import { Vector2 } from "./vector.js";

// Система зіткнень відокремлена від World: вона лише ГЕНЕРУЄ пари. Її можна
// замінити на просторовий хеш, не чіпаючи ні World, ні сутності.
// Порядок пар визначається порядком вставки в Map світу, тобто детермінований.
export function* findCollisions(world) {
  const list = [];
  for (const entity of world) {
    if (entity.alive && entity.collidable) list.push(entity);
  }

  // O(n²): для арени на десятки сутностей достатньо.
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      if (!a.alive || !b.alive) continue;
      const dx = a.pos.x - b.pos.x;
      const dy = a.pos.y - b.pos.y;
      const reach = a.radius + b.radius;
      if (dx * dx + dy * dy < reach * reach) yield [a, b];
    }
  }
}

// Відштовхування `from` -> `target`: додаткова швидкість вздовж нормалі.
function knockback(target, from, speed) {
  let normal = target.pos.sub(from.pos);
  normal = normal.length() === 0 ? new Vector2(1, 0) : normal.normalize();
  target.vel = target.vel.add(normal.scale(speed));
}

// Ключ — відсортована пара видів; аргументи передаються в тому ж порядку.
const handlers = {
  "asteroid|bullet": (asteroid, bullet, world) => {
    bullet.alive = false;
    if (asteroid.takeDamage(world)) {
      world.get(bullet.ownerId)?.addScore(SCORE.asteroid);
    }
  },
  "asteroid|ship": (asteroid, ship, world) => {
    knockback(ship, asteroid, 120);
    if (ship.takeDamage(world) !== DAMAGE.none) asteroid.takeDamage(world);
  },
  "bullet|ship": (bullet, ship, world) => {
    if (bullet.ownerId === ship.id) return; // у себе не влучаємо
    bullet.alive = false;
    if (ship.takeDamage(world) === DAMAGE.killed) {
      world.get(bullet.ownerId)?.addScore(SCORE.kill);
    }
  },
  "pickup|ship": (pickup, ship) => {
    pickup.applyTo(ship);
  },
  "ship|ship": (a, b) => {
    knockback(a, b, 80);
    knockback(b, a, 80);
  },
};

export function resolvePair(a, b, world) {
  const [first, second] = a.kind <= b.kind ? [a, b] : [b, a];
  handlers[`${first.kind}|${second.kind}`]?.(first, second, world);
}
