// Демо: що буде без слухача "error" і без обробки відхилень (Lab 04, M4).
// Скрипт запускає себе в дочірніх процесах і друкує витяг із виводу.
//
//   node scripts/crash-demo.mjs
import { spawnSync } from "node:child_process";
import { WebSocket, WebSocketServer } from "ws";

const [, , mode] = process.argv;

async function runWsDemo({ withListener }) {
  const wss = new WebSocketServer({ port: 0, maxPayload: 1024 });
  wss.on("connection", (socket) => {
    // ВИПРАВЛЕННЯ — ці три рядки. Без них подія "error" не має слухача.
    if (withListener) {
      socket.on("error", (error) =>
        console.log("socket error:", error.message),
      );
    }
    socket.on("message", () => {});
  });
  await new Promise((resolve) => wss.once("listening", resolve));

  const client = new WebSocket(`ws://127.0.0.1:${wss.address().port}`);
  client.on("error", () => {});
  client.on("open", () => client.send("x".repeat(2048))); // більше за maxPayload

  setTimeout(() => {
    console.log("сервер усе ще працює");
    process.exit(0);
  }, 500);
}

if (mode === "ws-broken") await runWsDemo({ withListener: false });
else if (mode === "ws-fixed") await runWsDemo({ withListener: true });
else if (mode === "rejection-broken") {
  // Проміс відхилено, ніхто не зробив .catch / try-await.
  Promise.reject(new Error("handler забув обробити помилку"));
  setTimeout(() => console.log("сервер усе ще працює"), 500);
} else if (mode === "rejection-fixed") {
  process.on("unhandledRejection", (error) => {
    console.log("логуємо й завершуємось контрольовано:", error.message);
    process.exit(1);
  });
  Promise.reject(new Error("handler забув обробити помилку"));
} else {
  for (const m of [
    "ws-broken",
    "ws-fixed",
    "rejection-broken",
    "rejection-fixed",
  ]) {
    const run = spawnSync(process.execPath, [import.meta.filename, m], {
      encoding: "utf8",
    });
    const text = `${run.stdout}${run.stderr}`
      .split("\n")
      .filter(
        (line) =>
          line.trim() &&
          !line.includes("node:internal") &&
          !/^\s+at /.test(line),
      )
      .slice(0, 6)
      .join("\n");
    console.log(`\n=== ${m}  (код виходу ${run.status}) ===\n${text}`);
  }
}
