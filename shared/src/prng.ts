// mulberry32: маленький швидкий генератор із 32-бітним станом. Єдине
// джерело «випадковості» в симуляції: той самий seed — та сама послідовність
// на сервері, в Node і в браузері. Math.random() у sim/ заборонено.
export interface Rng {
  (): number;
  getState(): number;
  setState(value: number): void;
}

export function mulberry32(seed: number): Rng {
  let state = seed >>> 0;

  function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // Стан можна зняти й відновити (потрібно для хешу світу й тестів).
  return Object.assign(next, {
    getState: (): number => state,
    setState: (value: number): void => {
      state = value >>> 0;
    },
  });
}
