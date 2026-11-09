import { Counter, collectDefaultMetrics, Gauge, Registry } from "prom-client";

// Метрики для Prometheus (GET /metrics, формат text exposition).
// Лічильники (Counter) лише ростуть: швидкість рахує Prometheus
//   rate(dogfight_messages_in_total[1m])  -> повідомлень/с
// Gauge-и «зараз» читаються в момент скрейпу (collect), а не оновлюються
// на кожну подію: гарячий шлях (30 Гц × гравці) нічого зайвого не робить.
export interface MetricSources {
  connections(): number;
  players(): number;
  rooms(): number;
  matches(): readonly {
    room: string;
    ticker: {
      workMs?: { p99: number };
      jitterMs?: { p99: number };
      skipped: number;
    };
  }[];
}

export type RejectReason =
  | "origin"
  | "ip_limit"
  | "bad_path"
  | "rate_limit"
  | "invalid_message"
  | "room_full"
  | "room_not_found"
  | "join_timeout"
  | "slow_client"
  | "too_big"
  | "draining";

export class Metrics {
  readonly registry = new Registry();
  #sources: MetricSources | null = null;

  readonly messagesIn: Counter<"kind">;
  readonly messagesOut: Counter;
  readonly bytesIn: Counter;
  readonly bytesOut: Counter;
  readonly rejections: Counter<"reason">;
  readonly closes: Counter<"code">;

  // defaultMetrics: process_*, nodejs_eventloop_lag_*, nodejs_gc_* (RSS, CPU, GC).
  // У тестах вимикаємо: вони не потрібні й додають фонові спостерігачі.
  constructor({ defaultMetrics = true }: { defaultMetrics?: boolean } = {}) {
    const registry = this.registry;
    if (defaultMetrics) collectDefaultMetrics({ register: registry });

    const src = (): MetricSources | null => this.#sources;
    this.messagesIn = new Counter({
      name: "dogfight_messages_in_total",
      help: "Повідомлень від клієнтів (input/ping/інші)",
      labelNames: ["kind"],
      registers: [registry],
    });
    this.messagesOut = new Counter({
      name: "dogfight_messages_out_total",
      help: "Повідомлень клієнтам",
      registers: [registry],
    });
    this.bytesIn = new Counter({
      name: "dogfight_bytes_in_total",
      help: "Байт від клієнтів",
      registers: [registry],
    });
    this.bytesOut = new Counter({
      name: "dogfight_bytes_out_total",
      help: "Байт клієнтам",
      registers: [registry],
    });
    this.rejections = new Counter({
      name: "dogfight_rejections_total",
      help: "Відхилені з'єднання/повідомлення за причиною",
      labelNames: ["reason"],
      registers: [registry],
    });
    this.closes = new Counter({
      name: "dogfight_ws_closes_total",
      help: "Закриття WebSocket за кодом",
      labelNames: ["code"],
      registers: [registry],
    });

    new Gauge({
      name: "dogfight_connections",
      help: "Відкритих WebSocket-з'єднань",
      registers: [registry],
      collect() {
        this.set(src()?.connections() ?? 0);
      },
    });
    new Gauge({
      name: "dogfight_players",
      help: "Гравців у кімнатах (включно з ботами)",
      registers: [registry],
      collect() {
        this.set(src()?.players() ?? 0);
      },
    });
    new Gauge({
      name: "dogfight_rooms",
      help: "Активних кімнат",
      registers: [registry],
      collect() {
        this.set(src()?.rooms() ?? 0);
      },
    });
    new Gauge({
      name: "dogfight_tick_work_p99_ms",
      help: "p99 тривалості тика гри (мс, вікно ~10 с) по кімнатах",
      labelNames: ["room"],
      registers: [registry],
      collect() {
        this.reset();
        for (const m of src()?.matches() ?? []) {
          this.set({ room: m.room }, m.ticker.workMs?.p99 ?? 0);
        }
      },
    });
    new Gauge({
      name: "dogfight_tick_jitter_p99_ms",
      help: "p99 запізнення таймера тика (мс) по кімнатах",
      labelNames: ["room"],
      registers: [registry],
      collect() {
        this.reset();
        for (const m of src()?.matches() ?? []) {
          this.set({ room: m.room }, m.ticker.jitterMs?.p99 ?? 0);
        }
      },
    });
    new Gauge({
      name: "dogfight_ticks_skipped",
      help: "Пропущених тиків (відставання від реального часу) по кімнатах",
      labelNames: ["room"],
      registers: [registry],
      collect() {
        this.reset();
        for (const m of src()?.matches() ?? []) {
          this.set({ room: m.room }, m.ticker.skipped);
        }
      },
    });

    // ELU між двома скрейпами: частка часу, коли цикл подій був зайнятий (0..1).
    let previous = performance.eventLoopUtilization();
    new Gauge({
      name: "dogfight_event_loop_utilization",
      help: "Завантаження event loop між скрейпами (0..1)",
      registers: [registry],
      collect() {
        const current = performance.eventLoopUtilization();
        this.set(
          performance.eventLoopUtilization(current, previous).utilization,
        );
        previous = current;
      },
    });
  }

  bind(sources: MetricSources): void {
    this.#sources = sources;
  }

  reject(reason: RejectReason): void {
    this.rejections.inc({ reason });
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
