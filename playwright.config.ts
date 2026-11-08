import { defineConfig } from "@playwright/test";

// e2e: збірка клієнта + справжній сервер на окремому порту, два контексти
// браузера в одній кімнаті (див. e2e/two-players.spec.ts).
const PORT = 3917;

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  retries: process.env["CI"] ? 1 : 0,
  reporter: process.env["CI"] ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
  },
  webServer: {
    command: "npm run build && npm run start",
    url: `http://127.0.0.1:${PORT}/health`,
    env: { PORT: String(PORT), HOST: "127.0.0.1", LOG_DIR: "e2e/.logs" },
    reuseExistingServer: !process.env["CI"],
    timeout: 120_000,
  },
});
