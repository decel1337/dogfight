import {
  postJson,
  type RequestOptions,
  requestJson,
} from "../assets/loader.ts";

// Кімната в списку лобі. Приходить з мережі, тож створюється лише через
// parseRooms (перевірка форми), а не приведенням типу.
export interface RoomInfo {
  id: string;
  name: string;
  players?: number;
  maxPlayers: number;
  arena?: { width: number; height: number };
}

export interface JoinDetail {
  room: RoomInfo;
  playerName: string;
}

// Назва події -> тип detail. Один словник керує і dispatch, і підписками.
export interface LobbyEventMap {
  rooms: readonly RoomInfo[];
  "lobby-error": Error;
  joined: JoinDetail;
}

type LobbyListener<K extends keyof LobbyEventMap> = (
  event: CustomEvent<LobbyEventMap[K]>,
) => void;

export type RequestFn = (
  url: string,
  options: RequestOptions & { retries?: number },
) => Promise<unknown>;
export type PostFn = (
  url: string,
  body: unknown,
  options: RequestOptions,
) => Promise<unknown>;

export interface LobbyOptions {
  url?: string;
  pollMs?: number;
  timeoutMs?: number;
  request?: RequestFn;
  post?: PostFn;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseRooms(raw: unknown): RoomInfo[] {
  if (!Array.isArray(raw)) throw new TypeError("Очікувався масив кімнат");
  return raw.map((item: unknown): RoomInfo => {
    if (!isRecord(item)) throw new TypeError("Некоректна кімната");
    const { id, name, players, maxPlayers, arena } = item;
    if (
      typeof id !== "string" ||
      typeof name !== "string" ||
      typeof maxPlayers !== "number"
    ) {
      throw new TypeError("Некоректна кімната");
    }
    const room: RoomInfo = { id, name, maxPlayers };
    if (typeof players === "number") room.players = players;
    if (
      isRecord(arena) &&
      typeof arena.width === "number" &&
      typeof arena.height === "number"
    ) {
      room.arena = { width: arena.width, height: arena.height };
    }
    return room;
  });
}

// Злиття інтерфейсу з класом додає типізовані перевантаження до успадкованих
// addEventListener/removeEventListener без жодного коду й приведень типів.
export interface Lobby {
  addEventListener<K extends keyof LobbyEventMap>(
    type: K,
    listener: LobbyListener<K>,
    options?: AddEventListenerOptions | boolean,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean,
  ): void;
  removeEventListener<K extends keyof LobbyEventMap>(
    type: K,
    listener: LobbyListener<K>,
    options?: EventListenerOptions | boolean,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean,
  ): void;
}

// Лобі — EventTarget: UI підписується на події, а не викликається напряму.
// Події: "rooms" (оновлено список), "lobby-error", "joined".
// Перевизначені addEventListener/removeEventListener прив'язують назву події
// до типу detail: `lobby.addEventListener("rooms", e => e.detail)` — e.detail
// це RoomInfo[], а помилка в назві не скомпілюється.
export class Lobby extends EventTarget {
  readonly url: string;
  readonly pollMs: number;
  readonly timeoutMs: number;
  readonly request: RequestFn;
  readonly post: PostFn;
  rooms: readonly RoomInfo[] = [];
  #timer: ReturnType<typeof setInterval> | null = null;
  #lifetime: AbortController | null = null;

  constructor({
    url = "/api/rooms",
    pollMs = 4000,
    timeoutMs = 3000,
    request = requestJson,
    post = postJson,
  }: LobbyOptions = {}) {
    super();
    this.url = url;
    this.pollMs = pollMs;
    this.timeoutMs = timeoutMs;
    this.request = request;
    this.post = post;
  }

  // Єдина точка відправки: назва й detail узгоджені через LobbyEventMap.
  #emit<K extends keyof LobbyEventMap>(
    type: K,
    detail: LobbyEventMap[K],
  ): void {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  async refresh(): Promise<void> {
    const lifetime = this.#lifetime;
    try {
      // Таймаут на кожен запит (timeoutMs) + скасування при виході з лобі
      // (signal). retries: 0 — наступну спробу зробить опитування.
      const raw = await this.request(this.url, {
        signal: lifetime?.signal,
        timeoutMs: this.timeoutMs,
        retries: 0,
      });
      if (lifetime?.signal.aborted) return;
      const rooms = parseRooms(raw);
      this.rooms = rooms;
      this.#emit("rooms", rooms);
    } catch (error: unknown) {
      if (lifetime?.signal.aborted) return;
      this.#emit(
        "lobby-error",
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  // Створює кімнату на сервері (POST /api/rooms) і одразу оновлює список.
  async createRoom({
    name,
  }: {
    name?: string | undefined;
  } = {}): Promise<unknown> {
    const room = await this.post(this.url, name ? { name } : {}, {
      signal: this.#lifetime?.signal,
      timeoutMs: this.timeoutMs,
    });
    await this.refresh();
    return room;
  }

  start(): void {
    if (this.#lifetime) return;
    this.#lifetime = new AbortController();
    void this.refresh();
    this.#timer = setInterval(() => void this.refresh(), this.pollMs);
  }

  // Зупиняє опитування і скасовує запит, що ще летить.
  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    this.#lifetime?.abort();
    this.#lifetime = null;
  }

  join(roomId: string, playerName: string): boolean {
    const room = this.rooms.find((r) => r.id === roomId);
    if (!room) {
      this.#emit("lobby-error", new Error(`Кімнату ${roomId} не знайдено`));
      return false;
    }
    this.stop();
    this.#emit("joined", { room, playerName });
    return true;
  }
}
