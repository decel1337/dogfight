// Спільні типи домену. Тут живуть «брендовані» ідентифікатори: за ними
// компілятор розрізняє числа, які в JS однакові (EntityId, PlayerId).

declare const brand: unique symbol;

// Номінальна типізація поверх структурної: значення — звичайне число, але
// тип несе «мітку», якої немає в runtime (вона стирається).
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type EntityId = Brand<number, "EntityId">;
export type PlayerId = Brand<number, "PlayerId">;
// Номер кроку симуляції і порядковий номер input-у — обидва u32, але
// плутати їх не можна: ack (SeqNo) не передати туди, де чекають Tick.
export type Tick = Brand<number, "Tick">;
export type SeqNo = Brand<number, "SeqNo">;

// Єдине місце в проєкті, де число «стає» брендованим: усі конструктори
// нижче викликають його. Приведення справедливе: runtime-значення не
// змінюється, а перевірку діапазону роблять самі конструктори.
function brandNumber<B extends Brand<number, string>>(n: number): B {
  return n as B;
}

export const NO_ENTITY: EntityId = brandNumber<EntityId>(0);

export function entityId(n: number): EntityId {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) {
    throw new RangeError(`EntityId поза діапазоном u16: ${n}`);
  }
  return brandNumber<EntityId>(n);
}

export function playerId(n: number): PlayerId {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) {
    throw new RangeError(`PlayerId поза діапазоном u16: ${n}`);
  }
  return brandNumber<PlayerId>(n);
}

const U32_MAX = 0xffffffff;

export function tick(n: number): Tick {
  if (!Number.isInteger(n) || n < 0 || n > U32_MAX) {
    throw new RangeError(`Tick поза діапазоном u32: ${n}`);
  }
  return brandNumber<Tick>(n);
}

export function seqNo(n: number): SeqNo {
  if (!Number.isInteger(n) || n < 0 || n > U32_MAX) {
    throw new RangeError(`SeqNo поза діапазоном u32: ${n}`);
  }
  return brandNumber<SeqNo>(n);
}

export const TICK_ZERO: Tick = brandNumber<Tick>(0);
export const SEQ_ZERO: SeqNo = brandNumber<SeqNo>(0);

export type Arena = Readonly<{ width: number; height: number }>;

// Виключна перевірка вичерпності: якщо у union з'явиться новий варіант, а
// switch його не обробить, аргумент перестане бути `never` і компіляція впаде.
export function assertNever(value: never, what = "значення"): never {
  throw new Error(`Необроблений варіант (${what}): ${JSON.stringify(value)}`);
}
