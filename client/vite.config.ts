import { defineConfig } from "vite";

// У розробці Vite проксірує /api і /ws на Node-сервер (server/, порт 3000),
// тож клієнт звертається до свого origin і не потребує CORS.
const target = process.env.VITE_SERVER ?? "http://localhost:3000";

export default defineConfig({
  server: {
    proxy: {
      "/api": target,
      // Сервер перевіряє Origin рукостискання (Lab 8): у dev підставляємо origin цілі,
      // бо Vite пересилає Origin сторінки (5173), що не збігається з Host (3000).
      "/ws": {
        target,
        ws: true,
        configure: (proxy) => {
          proxy.on("proxyReqWs", (proxyReq) =>
            proxyReq.setHeader("origin", target),
          );
        },
      },
    },
  },
});
