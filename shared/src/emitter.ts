// Типізований емітер подій: назва події жорстко пов'язана з типом даних.
//
//   const bus = new Emitter<{ fired: { id: number }; tick: number }>();
//   bus.on("fired", (d) => d.id);   // d: { id: number }
//   bus.emit("tick", "oops");       // ПОМИЛКА КОМПІЛЯЦІЇ: очікується number
//
// Тип `Events` — це «словник» назва -> payload; generic `K extends keyof Events`
// зв'язує аргументи on/emit між собою.
type Handler<T> = (detail: T) => void;

export class Emitter<Events extends object> {
  // Сховище гетерогенне (у кожної події свій тип обробника), тому всередині
  // тримаємо його у «стертому» вигляді; зовнішній API при цьому повністю
  // типізований. Це єдине приведення типу в емітері.
  readonly #handlers = new Map<keyof Events, Set<Handler<never>>>();

  on<K extends keyof Events>(type: K, handler: Handler<Events[K]>): () => void {
    let set = this.#handlers.get(type);
    if (!set) {
      set = new Set();
      this.#handlers.set(type, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  emit<K extends keyof Events>(type: K, detail: Events[K]): void {
    const set = this.#handlers.get(type);
    if (!set) return;
    for (const handler of set) (handler as Handler<Events[K]>)(detail);
  }
}
