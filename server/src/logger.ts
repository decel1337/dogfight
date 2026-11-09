import pino from "pino";

// Структуровані логи (pino): одна JSON-подія на рядок у stdout. Рядок — це
// не «текст для людини», а запис із полями, за якими можна фільтрувати:
//   {"level":30,"time":"...","service":"dogfight","msg":"player joined","room":"r1","playerId":3}
// Docker/Fly збирають stdout самі, окремих файлів і ротації не треба.
export type LogMeta = Record<string, unknown>;
export type LogLevel =
  | "fatal"
  | "error"
  | "warn"
  | "info"
  | "debug"
  | "trace"
  | "silent";

export interface Logger {
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, meta?: LogMeta): void;
  // Дочірній логер додає поля до КОЖНОГО свого запису (roomId, playerId, socket).
  child(bindings: LogMeta): Logger;
}

function wrap(base: pino.Logger): Logger {
  return {
    debug: (message, meta) =>
      meta ? base.debug(meta, message) : base.debug(message),
    info: (message, meta) =>
      meta ? base.info(meta, message) : base.info(message),
    warn: (message, meta) =>
      meta ? base.warn(meta, message) : base.warn(message),
    error: (message, meta) =>
      meta ? base.error(meta, message) : base.error(message),
    child: (bindings) => wrap(base.child(bindings)),
  };
}

export interface LoggerOptions {
  level?: LogLevel;
  // Поля, що додаються до кожного запису (версія збірки).
  base?: LogMeta;
  // Для тестів: куди писати (за замовчуванням stdout).
  destination?: pino.DestinationStream;
}

export function createLogger({
  level = "info",
  base = {},
  destination,
}: LoggerOptions = {}): Logger {
  const options: pino.LoggerOptions = {
    level,
    base: { service: "dogfight", ...base },
    timestamp: pino.stdTimeFunctions.isoTime,
    // "level":"info" замість числа 30: читабельніше в docker logs.
    formatters: { level: (label) => ({ level: label }) },
    // Усе, що схоже на секрет, у логи не потрапляє.
    redact: {
      paths: ["token", "*.token", "authorization", "*.authorization"],
      censor: "[redacted]",
    },
  };
  return wrap(destination ? pino(options, destination) : pino(options));
}

const noop = (): void => {};
export const silentLogger: Logger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  child() {
    return silentLogger;
  },
};
