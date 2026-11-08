import assert from "node:assert/strict";
import { test } from "vitest";
import { ConfigError, loadConfig } from "../src/config.ts";

test("config: значення за замовчуванням", () => {
  const config = loadConfig({});
  assert.equal(config.port, 3000);
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.joinTimeoutMs, 5000);
  assert.equal(config.heartbeatMs, 15_000);
  assert.equal(config.maxMissedPongs, 2);
  assert.equal(config.debugRoutes, false);
});

test("config: читає та приводить типи з env", () => {
  const config = loadConfig({
    PORT: "8080",
    HOST: "0.0.0.0",
    LOG_DIR: "/var/log/x",
    ENABLE_DEBUG_ROUTES: "1",
  });
  assert.equal(config.port, 8080);
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.logDir, "/var/log/x");
  assert.equal(config.debugRoutes, true);
});

test("config: збирає ВСІ помилки одразу", () => {
  assert.throws(
    () => loadConfig({ PORT: "abc", MAX_ROOMS: "0", ENABLE_DEBUG_ROUTES: "maybe" }),
    (error) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.problems.length, 3);
      assert.match(error.message, /PORT/);
      assert.match(error.message, /MAX_ROOMS/);
      assert.match(error.message, /ENABLE_DEBUG_ROUTES/);
      return true;
    },
  );
});

test("config: об'єкт заморожений", () => {
  const config = loadConfig({});
  assert.throws(() => {
    // @ts-expect-error — Config readonly; перевіряємо, що й у рантаймі заморожений
    config.port = 1;
  }, TypeError);
});
