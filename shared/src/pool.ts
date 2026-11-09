// Пул об'єктів: acquire() віддає вільний (або створює новий), release()
// повертає. Мета — не створювати й не віддавати GC короткоживучі об'єкти
// (кулі, частинки) щокадру/щотику. Ціна: об'єкт після release() МОЖЕ бути
// перевикористаний, тож тримати на нього посилання не можна.
export class Pool<T> {
  readonly #free: T[] = [];
  readonly #create: () => T;
  readonly #max: number;
  created = 0;

  constructor(create: () => T, max = 4096) {
    this.#create = create;
    this.#max = max;
  }

  get available(): number {
    return this.#free.length;
  }

  acquire(): T {
    const item = this.#free.pop();
    if (item !== undefined) return item;
    this.created++;
    return this.#create();
  }

  release(item: T): void {
    if (this.#free.length < this.#max) this.#free.push(item);
  }
}
