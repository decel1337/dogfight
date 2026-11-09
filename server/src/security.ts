import type http from "node:http";

// Перевірка Origin для WebSocket.
//
// CORS на WebSocket НЕ поширюється: будь-яка сторінка в браузері може
// відкрити new WebSocket("wss://наш-сервер/ws"), і браузер надішле cookie й
// заголовок Origin цієї чужої сторінки (Cross-Site WebSocket Hijacking).
// Єдиний захист — самому перевірити Origin під час рукостискання.
//
// Правила:
//  - Origin відсутній -> дозволено: його не шле не-браузерний клієнт
//    (боти, loadtest, curl). Браузер заголовок Origin шле завжди, тож
//    підробити чужу сторінку без нього неможливо.
//  - Origin у ALLOWED_ORIGINS -> дозволено.
//  - Origin того ж хоста, що й Host запиту (same-origin) -> дозволено.
//  - Решта -> 403.
export function isOriginAllowed(
  origin: string | undefined,
  host: string | undefined,
  allowed: readonly string[],
): boolean {
  if (origin === undefined) return true;
  const normalized = origin.toLowerCase().replace(/\/+$/, "");
  if (allowed.some((entry) => entry.toLowerCase() === normalized)) return true;
  if (host === undefined) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false; // "null" та інше сміття
  }
}

// IP клієнта для ліміту з'єднань.
//
// Без довіреного проксі X-Forwarded-For — просто заголовок, який клієнт
// пише що завгодно, тож беремо адресу TCP-сокета. За reverse proxy
// (Fly, nginx) усі з'єднання приходять з IP проксі, тому при TRUST_PROXY=1
// беремо ОСТАННІЙ елемент X-Forwarded-For — той, що додав наш довірений
// проксі (лівіші записи клієнт міг підробити).
export function clientIp(
  req: http.IncomingMessage,
  trustProxy: boolean,
): string {
  if (trustProxy) {
    const header = req.headers["x-forwarded-for"];
    const raw = Array.isArray(header) ? header.join(",") : header;
    const last = raw?.split(",").at(-1)?.trim();
    if (last) return last;
  }
  return req.socket.remoteAddress ?? "unknown";
}

// Лічильник з'єднань за ключем із жорстким верхнім лімітом.
export class ConnectionCounter {
  readonly #counts = new Map<string, number>();
  readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  // true, якщо слот виділено.
  acquire(key: string): boolean {
    const count = this.#counts.get(key) ?? 0;
    if (count >= this.limit) return false;
    this.#counts.set(key, count + 1);
    return true;
  }

  release(key: string): void {
    const count = this.#counts.get(key) ?? 0;
    if (count <= 1) this.#counts.delete(key);
    else this.#counts.set(key, count - 1);
  }

  get keys(): number {
    return this.#counts.size;
  }
}
