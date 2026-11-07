import { defineConfig } from "vite";

// У розробці Vite проксірує /api і /ws на Node-сервер (server/, порт 3000),
// тож клієнт звертається до свого origin і не потребує CORS.
const target = process.env.VITE_SERVER ?? "http://localhost:3000";

export default defineConfig({
  server: {
    proxy: {
      "/api": target,
      "/ws": { target, ws: true },
    },
  },
});
