import type { World } from "./world.ts";
// FNV-1a 32 біти по рядку. Достатньо, щоб порівнювати стани між рушіями.
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

// Хеш повного (нерізаного) стану світу разом зі станом PRNG. Числа
// серіалізуються JSON.stringify, який дає найкоротший запис, що точно
// відновлює значення, тож однаковий результат у Node і в браузері означає
// побітово однакові числа.
export function hashWorld(world: World): number {
  const { tick, entities } = world.snapshot();
  return fnv1a(JSON.stringify({ tick, entities, rng: world.rng.getState() }));
}
