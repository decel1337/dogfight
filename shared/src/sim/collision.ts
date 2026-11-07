import { type AnyEntity, DAMAGE, isKind } from "./entities.ts";
import type { Entity, EntityKind, EntityOf } from "./entity.ts";
import type { World } from "./world.ts";
import { SCORE } from "../constants.ts";
import { Vector2 } from "./vector.ts";

// Система зіткнень відокремлена від World: вона лише ГЕНЕРУЄ пари. Її можна
// замінити на просторовий хеш, не чіпаючи ні World, ні сутності.
// Порядок пар визначається порядком вставки в Map світу, тобто детермінований.
export type CollisionFinder = (world: World) => Iterable<readonly [AnyEntity, AnyEntity]>;

export function* findCollisions(world: World): Generator<readonly [AnyEntity, AnyEntity]> {
  const list: AnyEntity[] = [];
  for (const entity of world) {
    if (entity.alive && entity.collidable) list.push(entity);
  }

  // O(n²): для арени на десятки сутностей достатньо.
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      if (!a || !b) continue;
      if (!a.alive || !b.alive) continue;
      const dx = a.pos.x - b.pos.x;
      const dy = a.pos.y - b.pos.y;
      const reach = a.radius + b.radius;
      if (dx * dx + dy * dy < reach * reach) yield [a, b];
    }
  }
}

// Відштовхування `from` -> `target`: додаткова швидкість вздовж нормалі.
function knockback(target: Entity, from: Entity, speed: number): void {
  let normal = target.pos.sub(from.pos);
  normal = normal.length() === 0 ? new Vector2(1, 0) : normal.normalize();
  target.vel = target.vel.add(normal.scale(speed));
}

// Правило зіткнення для пари видів (A, B). Generic-параметри зв'язують види з
// типами аргументів обробника: у правилі "asteroid"+"bullet" перший
// аргумент — Asteroid, другий — Bullet, без жодних приведень.
type Rule = (a: AnyEntity, b: AnyEntity, world: World) => boolean;

function rule<A extends EntityKind, B extends EntityKind>(
  kindA: A,
  kindB: B,
  handler: (a: EntityOf<A>, b: EntityOf<B>, world: World) => void,
): Rule {
  return (x, y, world) => {
    // пара приходить у довільному порядку — пробуємо обидва
    if (isKind(x, kindA) && isKind(y, kindB)) handler(x, y, world);
    else if (isKind(y, kindA) && isKind(x, kindB)) handler(y, x, world);
    else return false;
    return true;
  };
}

const rules: readonly Rule[] = [
  rule("asteroid", "bullet", (asteroid, bullet, world) => {
    bullet.alive = false;
    if (asteroid.takeDamage(world)) {
      world.getShip(bullet.ownerId)?.addScore(SCORE.asteroid);
    }
  }),
  rule("asteroid", "ship", (asteroid, ship, world) => {
    knockback(ship, asteroid, 120);
    if (ship.takeDamage(world) !== DAMAGE.none) asteroid.takeDamage(world);
  }),
  rule("bullet", "ship", (bullet, ship, world) => {
    if (bullet.ownerId === ship.id) return; // у себе не влучаємо
    bullet.alive = false;
    if (ship.takeDamage(world) === DAMAGE.killed) {
      world.getShip(bullet.ownerId)?.addScore(SCORE.kill);
    }
  }),
  rule("pickup", "ship", (pickup, ship) => {
    pickup.applyTo(ship);
  }),
  rule("ship", "ship", (a, b) => {
    knockback(a, b, 80);
    knockback(b, a, 80);
  }),
];

export function resolvePair(a: AnyEntity, b: AnyEntity, world: World): void {
  for (const apply of rules) {
    if (apply(a, b, world)) return;
  }
}
