import { createApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger();

let config;
try {
  config = loadConfig();
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  log.error(error.message);
  process.exit(1);
}

const app = createApp({ config, log });

// Сервер не «ковтає» непередбачені помилки: після них стан процесу
// невідомий. Логуємо причину й завершуємось з кодом 1 (supervisor
// перезапустить). Без цих рядків Node зробив би те саме, але без логу.
function fatal(kind) {
  return (error) => {
    log.error(kind, { error: error?.stack ?? String(error) });
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
    log.info("signal received", { signal });

    // Страховка: якщо щось зависло, не висимо вічно.
    const watchdog = setTimeout(() => {
      log.error("shutdown timed out");
      process.exit(1);
    }, config.shutdownTimeoutMs + 2000);
    watchdog.unref();

    try {
      await app.stop();
      process.exitCode = 0; // цикл подій спорожніє сам -> код 0
    } catch (error) {
      log.error("shutdown failed", { error: error.stack });
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
});
