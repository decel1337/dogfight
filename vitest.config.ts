import { defineConfig } from "vitest/config";

// Один запуск на весь монорепозиторій: `npm test` (корінь) проганяє shared,
// server і client як окремі «проєкти» зі своїми include-шаблонами.
export default defineConfig({
  test: {
    environment: "node",
    // Серверні тести міряють таймери й піднімають порти: файли йдуть по черзі,
    // щоб навантаження одного не псувало вимірювання іншого.
    fileParallelism: false,
    testTimeout: 15_000,
    projects: [
      { test: { name: "shared", include: ["shared/test/**/*.test.ts"] } },
      { test: { name: "server", include: ["server/test/**/*.test.ts"] } },
      { test: { name: "client", include: ["client/tests/**/*.test.ts"] } },
    ],
    coverage: {
      provider: "v8",
      include: ["shared/src/**/*.ts"],
      reporter: ["text", "html", "json-summary"],
      thresholds: { lines: 85, statements: 85, functions: 85, branches: 80 },
    },
  },
});
