import path from "node:path";

export class ConfigError extends Error {
  constructor(problems) {
    super(`Некоректна конфігурація:\n - ${problems.join("\n - ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

const DEFAULT_STATIC_DIR = path.resolve(
  import.meta.dirname,
  "../../client/dist",
);

// Єдине місце, де сервер читає process.env. Решта коду отримує готовий,
// провалідований і заморожений об'єкт. Помилки збираємо всі разом, а не
// по одній, щоб не змушувати перезапускатися кілька разів.
export function loadConfig(env = process.env) {
  const problems = [];

  const int = (key, fallback, min, max) => {
    const raw = env[key];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      problems.push(
        `${key}: потрібне ціле число ${min}..${max}, отримано "${raw}"`,
      );
      return fallback;
    }
    return value;
  };

  const bool = (key, fallback) => {
    const raw = env[key];
    if (raw === undefined || raw === "") return fallback;
    if (["1", "true", "yes"].includes(raw.toLowerCase())) return true;
    if (["0", "false", "no"].includes(raw.toLowerCase())) return false;
    problems.push(`${key}: очікується 0/1/true/false, отримано "${raw}"`);
    return fallback;
  };

  const config = {
    port: int("PORT", 3000, 0, 65535),
    host: env.HOST || "127.0.0.1",
    logDir: path.resolve(env.LOG_DIR || "logs"),
    staticDir: path.resolve(env.STATIC_DIR || DEFAULT_STATIC_DIR),

    // HTTP
    maxBodyBytes: int("MAX_BODY_BYTES", 4096, 16, 1_000_000),
    maxRooms: int("MAX_ROOMS", 50, 1, 10_000),
    maxPlayersPerRoom: int("MAX_PLAYERS_PER_ROOM", 8, 1, 256),
    roomIdleMs: int("ROOM_IDLE_MS", 60_000, 10, 86_400_000),

    // WebSocket
    maxPayload: int("MAX_PAYLOAD", 2048, 16, 1_000_000),
    joinTimeoutMs: int("JOIN_TIMEOUT_MS", 5000, 10, 60_000),
    heartbeatMs: int("HEARTBEAT_MS", 15_000, 10, 300_000),
    maxMissedPongs: int("MAX_MISSED_PONGS", 2, 1, 10),
    // chat/керування й ігрові повідомлення мають окремі відра: потік input
    // (30/с) не повинен з'їдати ліміт чату, і навпаки.
    ratePerSec: int("RATE_PER_SEC", 10, 1, 1000),
    rateBurst: int("RATE_BURST", 20, 1, 10_000),
    inputRatePerSec: int("INPUT_RATE_PER_SEC", 60, 1, 10_000),
    inputRateBurst: int("INPUT_RATE_BURST", 120, 1, 100_000),
    enableNetsim: bool("ENABLE_NETSIM", true),
    bufferedLimit: int("BUFFERED_LIMIT", 1_048_576, 1024, 1_073_741_824),

    shutdownTimeoutMs: int("SHUTDOWN_TIMEOUT_MS", 5000, 100, 120_000),
    debugRoutes: bool("ENABLE_DEBUG_ROUTES", false),
  };

  if (problems.length > 0) throw new ConfigError(problems);
  return Object.freeze(config);
}
