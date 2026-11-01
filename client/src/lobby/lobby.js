import { postJson, requestJson } from "../assets/loader.js";

// Лобі — EventTarget: UI підписується на події, а не викликається напряму.
// Події: "rooms" (оновлено список), "lobby-error", "joined".
export class Lobby extends EventTarget {
  #timer = null;
  #lifetime = null;

  constructor({
    url = "/api/rooms",
    pollMs = 4000,
    timeoutMs = 3000,
    request = requestJson,
    post = postJson,
  } = {}) {
    super();
    this.url = url;
    this.pollMs = pollMs;
    this.timeoutMs = timeoutMs;
    this.request = request;
    this.post = post;
    this.rooms = [];
  }

  async refresh() {
    const lifetime = this.#lifetime;
    try {
      // Таймаут на кожен запит (timeoutMs) + скасування при виході з лобі
      // (signal). retries: 0 — наступну спробу зробить опитування.
      const rooms = await this.request(this.url, {
        signal: lifetime?.signal,
        timeoutMs: this.timeoutMs,
        retries: 0,
      });
      if (lifetime?.signal.aborted) return;
      if (!Array.isArray(rooms)) throw new TypeError("Очікувався масив кімнат");
      this.rooms = rooms;
      this.dispatchEvent(new CustomEvent("rooms", { detail: rooms }));
    } catch (error) {
      if (lifetime?.signal.aborted) return;
      this.dispatchEvent(new CustomEvent("lobby-error", { detail: error }));
    }
  }

  // Створює кімнату на сервері (POST /api/rooms) і одразу оновлює список.
  async createRoom({ name } = {}) {
    const room = await this.post(this.url, name ? { name } : {}, {
      signal: this.#lifetime?.signal,
      timeoutMs: this.timeoutMs,
    });
    await this.refresh();
    return room;
  }

  start() {
    if (this.#lifetime) return;
    this.#lifetime = new AbortController();
    this.refresh();
    this.#timer = setInterval(() => this.refresh(), this.pollMs);
  }

  // Зупиняє опитування і скасовує запит, що ще летить.
  stop() {
    clearInterval(this.#timer);
    this.#timer = null;
    this.#lifetime?.abort();
    this.#lifetime = null;
  }

  join(roomId, playerName) {
    const room = this.rooms.find((r) => r.id === roomId);
    if (!room) {
      const error = new Error(`Кімнату ${roomId} не знайдено`);
      this.dispatchEvent(new CustomEvent("lobby-error", { detail: error }));
      return false;
    }
    this.stop();
    this.dispatchEvent(
      new CustomEvent("joined", { detail: { room, playerName } }),
    );
    return true;
  }
}
