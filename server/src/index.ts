import { createApp } from "./app.ts";
import { type Config, ConfigError, loadConfig } from "./config.ts";
import { createLogger } from "./logger.ts";
import { Metrics } from "./metrics.ts";

// Рівень логів і версію читаємо до loadConfig, щоб помилки конфігу теж були JSON.
const bootLog = createLogger({ level: "info" });

function readConfig(): Config {
  try {
    return loadConfig();
  } catch (error: unknown) {
    if (!(error instanceof ConfigError)) throw error;
    bootLog.error("invalid config", { problems: error.problems });
    return process.exit(1);
  }
}

const config = readConfig();
const log = createLogger({
  level: config.logLevel,
  base: { version: config.version, sha: config.gitSha },
});

const app = createApp({ config, log, metrics: new Metrics() });

// Сервер не «ковтає» непередбачені помилки: після них стан процесу
// невідомий. Логуємо причину й завершуємось з кодом 1 (supervisor
// перезапустить). Без цих рядків Node зробив би те саме, але без логу.
const describe = (error: unknown): string =>
  error instanceof Error ? (error.stack ?? error.message) : String(error);

function fatal(kind: string): (error: unknown) => never {
  return (error) => {
    log.error(kind, { error: describe(error) });
    process.exit(1);
  };
}
process.on("uncaughtException", fatal("uncaughtException"));
process.on("unhandledRejection", fatal("unhandledRejection"));

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const began = Date.now();
    log.info("signal received", { signal });

    // Страховка: якщо щось зависло, не висимо вічно.
    const watchdog = setTimeout(() => {
      log.error("shutdown timed out");
      process.exit(1);
    }, config.shutdownTimeoutMs + 2000);
    watchdog.unref();

    try {
      await app.stop();
      log.info("shutdown complete", { signal, durationMs: Date.now() - began });
      process.exitCode = 0; // цикл подій спорожніє сам -> код 0
    } catch (error: unknown) {
      log.error("shutdown failed", { error: describe(error) });
      process.exit(1);
    }
  });
}

// Обробники сигналів реєструємо ДО "listening": інакше сигнал, що прийшов
// одразу після старту, вбив би процес із кодом сигналу замість graceful shutdown.
const address = await app.start();
log.info("listening", {
  host: address.address,
  port: address.port,
  logDir: config.logDir,
  node: process.version,
  pid: process.pid,
});
