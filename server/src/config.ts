import path from "node:path";
import { z } from "zod";

export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Некоректна конфігурація:\n - ${problems.join("\n - ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

const DEFAULT_STATIC_DIR = path.resolve(
  import.meta.dirname,
  "../../client/dist",
);

// env завжди рядки (або відсутні): порожній рядок рахуємо за «не задано».
const unset = (value: string | undefined): value is undefined | "" =>
  value === undefined || value === "";

// Ціле з env у діапазоні min..max; відсутнє -> fallback.
function int(fallback: number, min: number, max: number) {
  const message = `потрібне ціле число ${min}..${max}`;
  return z
    .string()
    .optional()
    .transform((raw) => (unset(raw) ? fallback : Number(raw)))
    .pipe(
      z
        .number({ invalid_type_error: message })
        .int(message)
        .min(min, message)
        .max(max, message),
    );
}

function bool(fallback: boolean) {
  return z
    .string()
    .optional()
    .transform((raw, ctx): boolean => {
      if (unset(raw)) return fallback;
      const value = raw.toLowerCase();
      if (["1", "true", "yes"].includes(value)) return true;
      if (["0", "false", "no"].includes(value)) return false;
      ctx.addIssue({ code: "custom", message: "очікується 0/1/true/false" });
      return fallback;
    });
}

function text(fallback: string) {
  return z
    .string()
    .optional()
    .transform((raw) => (unset(raw) ? fallback : raw));
}

// Схема описує ВСЕ, що сервер читає з process.env: ім'я змінної, тип,
// діапазон і значення за замовчуванням. Тип Config виводиться зі схеми.
const EnvSchema = z.object({
  PORT: int(3000, 0, 65535),
  HOST: text("127.0.0.1"),
  LOG_DIR: text("logs"),
  STATIC_DIR: text(DEFAULT_STATIC_DIR),

  // HTTP
  MAX_BODY_BYTES: int(4096, 16, 1_000_000),
  MAX_ROOMS: int(50, 1, 10_000),
  MAX_PLAYERS_PER_ROOM: int(8, 1, 256),
  ROOM_IDLE_MS: int(60_000, 10, 86_400_000),

  // WebSocket
  MAX_PAYLOAD: int(2048, 16, 1_000_000),
  JOIN_TIMEOUT_MS: int(5000, 10, 60_000),
  HEARTBEAT_MS: int(15_000, 10, 300_000),
  MAX_MISSED_PONGS: int(2, 1, 10),
  // chat/керування й ігрові повідомлення мають окремі відра: потік input
  // (30/с) не повинен з'їдати ліміт чату, і навпаки.
  RATE_PER_SEC: int(10, 1, 1000),
  RATE_BURST: int(20, 1, 10_000),
  INPUT_RATE_PER_SEC: int(60, 1, 10_000),
  INPUT_RATE_BURST: int(120, 1, 100_000),
  ENABLE_NETSIM: bool(true),
  BUFFERED_LIMIT: int(1_048_576, 1024, 1_073_741_824),

  SHUTDOWN_TIMEOUT_MS: int(5000, 100, 120_000),
  ENABLE_DEBUG_ROUTES: bool(false),

  // Production (Lab 8)
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  // Через кому. Порожньо = лише same-origin (Origin.host == Host).
  ALLOWED_ORIGINS: text(""),
  MAX_CONNECTIONS_PER_IP: int(20, 1, 10_000),
  // true лише за довіреним reverse proxy: тоді IP клієнта береться з X-Forwarded-For.
  TRUST_PROXY: bool(false),
  ENABLE_METRICS: bool(true),
  // Версія збірки: у контейнері задається з git SHA (build-arg).
  GIT_SHA: text("dev"),
  APP_VERSION: text("0.0.0"),
});

export interface Config {
  readonly port: number;
  readonly host: string;
  readonly logDir: string;
  readonly staticDir: string;
  readonly maxBodyBytes: number;
  readonly maxRooms: number;
  readonly maxPlayersPerRoom: number;
  readonly roomIdleMs: number;
  readonly maxPayload: number;
  readonly joinTimeoutMs: number;
  readonly heartbeatMs: number;
  readonly maxMissedPongs: number;
  readonly ratePerSec: number;
  readonly rateBurst: number;
  readonly inputRatePerSec: number;
  readonly inputRateBurst: number;
  readonly enableNetsim: boolean;
  readonly bufferedLimit: number;
  readonly shutdownTimeoutMs: number;
  readonly debugRoutes: boolean;
  readonly logLevel:
    | "fatal"
    | "error"
    | "warn"
    | "info"
    | "debug"
    | "trace"
    | "silent";
  readonly allowedOrigins: readonly string[];
  readonly maxConnectionsPerIp: number;
  readonly trustProxy: boolean;
  readonly enableMetrics: boolean;
  readonly gitSha: string;
  readonly version: string;
}

// Єдине місце, де сервер читає process.env. Решта коду отримує готовий,
// провалідований і заморожений об'єкт. Помилки збираємо всі разом, а не
// по одній, щоб не змушувати перезапускатися кілька разів.
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => {
        const key = String(issue.path[0] ?? "?");
        return `${key}: ${issue.message}, отримано "${env[key] ?? ""}"`;
      }),
    );
  }
  const e = parsed.data;
  const config: Config = {
    port: e.PORT,
    host: e.HOST,
    logDir: path.resolve(e.LOG_DIR),
    staticDir: path.resolve(e.STATIC_DIR),
    maxBodyBytes: e.MAX_BODY_BYTES,
    maxRooms: e.MAX_ROOMS,
    maxPlayersPerRoom: e.MAX_PLAYERS_PER_ROOM,
    roomIdleMs: e.ROOM_IDLE_MS,
    maxPayload: e.MAX_PAYLOAD,
    joinTimeoutMs: e.JOIN_TIMEOUT_MS,
    heartbeatMs: e.HEARTBEAT_MS,
    maxMissedPongs: e.MAX_MISSED_PONGS,
    ratePerSec: e.RATE_PER_SEC,
    rateBurst: e.RATE_BURST,
    inputRatePerSec: e.INPUT_RATE_PER_SEC,
    inputRateBurst: e.INPUT_RATE_BURST,
    enableNetsim: e.ENABLE_NETSIM,
    bufferedLimit: e.BUFFERED_LIMIT,
    shutdownTimeoutMs: e.SHUTDOWN_TIMEOUT_MS,
    debugRoutes: e.ENABLE_DEBUG_ROUTES,
    logLevel: e.LOG_LEVEL,
    allowedOrigins: Object.freeze(
      e.ALLOWED_ORIGINS.split(",")
        .map((o) => o.trim().replace(/\/+$/, ""))
        .filter((o) => o !== ""),
    ),
    maxConnectionsPerIp: e.MAX_CONNECTIONS_PER_IP,
    trustProxy: e.TRUST_PROXY,
    enableMetrics: e.ENABLE_METRICS,
    gitSha: e.GIT_SHA,
    version: e.APP_VERSION,
  };
  return Object.freeze(config);
}
