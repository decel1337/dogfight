// Константи, спільні для клієнта й сервера. Усе, від чого залежить
// детермінізм симуляції (крок часу, фізика), живе тут і ніде більше.

export const TICK_RATE = 30; // кроків симуляції за секунду (і снапшотів)
export const DT = 1 / TICK_RATE; // фіксований крок, секунди
export const TICK_MS = 1000 / TICK_RATE;

export const DEFAULT_ARENA = Object.freeze({ width: 1200, height: 800 });

// Таймери симуляції — цілі кроки, а не секунди: так вони точно
// вміщуються в u8 і не накопичують похибку float.
export const SHIP = Object.freeze({
  radius: 14,
  maxHp: 3,
  turnRate: 3.5, // рад/с
  thrust: 320, // px/с²
  drag: 0.985 * 0.985, // множник швидкості за крок (0.985 за 1/60 с)
  muzzle: 18, // відстань від центру до дула
  bulletSpeed: 420,
  homingBulletSpeed: 160,
  inheritVelocity: 0.3,
  cooldownTicks: 5,
  rapidCooldownTicks: 2,
  respawnTicks: 2 * TICK_RATE,
  invulnerableTicks: 1.5 * TICK_RATE,
  rapidTicks: 8 * TICK_RATE,
});

export const BULLET = Object.freeze({
  radius: 3,
  ttlTicks: Math.round(1.8 * TICK_RATE),
  homingTtlTicks: 4 * TICK_RATE,
});

export const SCORE = Object.freeze({ asteroid: 100, kill: 250 });
