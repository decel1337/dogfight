// Детермінована тригонометрія. Math.sin/cos/atan2 у стандарті ECMAScript
// "implementation-approximated": різні збірки V8 (Node і Chromium) інколи
// дають результати, що відрізняються на 1 ulp, — цього досить, щоб хеші
// світу розійшлися (див. README, «Prove it»). Тут лише +, −, ×, ÷ і sqrt,
// які IEEE 754 визначає точно, тож результат однаковий у будь-якому рушії.
// Точність ≈1e-12: для гри з головою вистачає.
const TWO_PI = 6.283185307179586;
const PI = 3.141592653589793;
const HALF_PI = 1.5707963267948966;

// Приводить кут до [-π, π] додаванням/відніманням 2π (без Math.floor/%,
// щоб не залежати від fmod-реалізації).
function reduce(x: number): number {
  while (x > PI) x -= TWO_PI;
  while (x < -PI) x += TWO_PI;
  return x;
}

// Ряд Тейлора для sin на [-π/2, π/2] (до x^19 — похибка < 1e-13).
function sinCore(x: number): number {
  const x2 = x * x;
  let term = x;
  let sum = x;
  for (let n = 1; n <= 9; n++) {
    term *= -x2 / (2 * n * (2 * n + 1));
    sum += term;
  }
  return sum;
}

export function sin(angle: number): number {
  let x = reduce(angle);
  if (x > HALF_PI) x = PI - x;
  else if (x < -HALF_PI) x = -PI - x;
  return sinCore(x);
}

export function cos(angle: number): number {
  return sin(angle + HALF_PI);
}

// atan: двічі зменшуємо аргумент тотожністю atan(x)=2·atan(x/(1+√(1+x²))),
// далі ряд Тейлора на |x| ≤ ~0.2.
function atan(x: number): number {
  const negative = x < 0;
  let v = negative ? -x : x;
  let inverted = false;
  if (v > 1) {
    v = 1 / v;
    inverted = true;
  }
  v = v / (1 + Math.sqrt(1 + v * v));
  v = v / (1 + Math.sqrt(1 + v * v));
  const v2 = v * v;
  let term = v;
  let sum = v;
  for (let n = 1; n <= 8; n++) {
    term *= -v2;
    sum += term / (2 * n + 1);
  }
  let result = sum * 4;
  if (inverted) result = HALF_PI - result;
  return negative ? -result : result;
}

export function atan2(y: number, x: number): number {
  if (x === 0 && y === 0) return 0;
  if (x > 0) return atan(y / x);
  if (x < 0) return y >= 0 ? atan(y / x) + PI : atan(y / x) - PI;
  return y > 0 ? HALF_PI : -HALF_PI;
}
