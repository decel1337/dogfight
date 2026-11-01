// Система зіткнень відокремлена від World: вона лише ГЕНЕРУЄ пари. Її можна
// замінити на просторовий хеш, не чіпаючи ні World, ні сутності.
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
      if (a.pos.dist(b.pos) < a.radius + b.radius) yield [a, b];
    }
  }
}

// Ключ — відсортована пара видів; аргументи передаються в тому ж порядку.
const handlers = {
  "asteroid|bullet": (asteroid, bullet, world) => {
    bullet.alive = false;
    if (asteroid.takeDamage(world)) {
      world.get(bullet.ownerId)?.addScore(100);
    }
  },
  "asteroid|ship": (asteroid, ship, world) => {
    if (ship.takeDamage(world)) asteroid.takeDamage(world);
  },
  "pickup|ship": (pickup, ship) => {
    pickup.applyTo(ship);
  },
};

export function resolvePair(a, b, world) {
  const [first, second] = a.kind <= b.kind ? [a, b] : [b, a];
  handlers[`${first.kind}|${second.kind}`]?.(first, second, world);
}
