import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { tempDir } from "./helpers.ts";

const ENTRY = path.resolve(import.meta.dirname, "../src/index.ts");

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function startServer(env: Record<string, string> = {}) {
  const logDir = tempDir("proc-logs-");
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--disable-warning=ExperimentalWarning",
      ENTRY,
    ],
    {
      env: {
        ...process.env,
        PORT: "0",
        HOST: "127.0.0.1",
        LOG_DIR: logDir,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let out = "";
  child.stdout.on("data", (c: Buffer) => (out += c));
  child.stderr.on("data", (c: Buffer) => (out += c));
  const exited = new Promise<Exit>((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal })),
  );
  const ready = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`не стартував:\n${out}`)),
      4000,
    );
    child.once("exit", () => clearTimeout(timer));
    child.stdout.on("data", () => {
      const match = /"port":(\d+)/.exec(out);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
  });
  ready.catch(() => {}); // не awaited у тесті про помилку конфігурації
  return { child, ready, exited, logDir, output: () => out };
}

test("SIGTERM: коректне завершення з кодом 0 і логом", {
  skip: process.platform === "win32",
}, async () => {
  const server = startServer();
  try {
    const port = await server.ready;
    await fetch(`http://127.0.0.1:${port}/health`);
    const began = Date.now();
    server.child.kill("SIGTERM");
    const { code } = await server.exited;
    assert.equal(code, 0);
    assert.ok(
      Date.now() - began < 10_000,
      "graceful shutdown вкладається в 10 с",
    );
    assert.match(server.output(), /shutdown: complete/);
    // Логи — JSON-рядки (pino): кожен рядок парситься й має level/msg/service.
    for (const line of server.output().trim().split("\n")) {
      const record = JSON.parse(line) as Record<string, unknown>;
      assert.equal(record.service, "dogfight");
      assert.equal(typeof record.level, "string");
      assert.equal(typeof record.msg, "string");
    }
  } finally {
    server.child.kill("SIGKILL");
    rmSync(server.logDir, { recursive: true, force: true });
  }
});

test("SIGINT теж завершує з кодом 0", {
  skip: process.platform === "win32",
}, async () => {
  const server = startServer();
  try {
    await server.ready;
    server.child.kill("SIGINT");
    assert.equal((await server.exited).code, 0);
  } finally {
    server.child.kill("SIGKILL");
    rmSync(server.logDir, { recursive: true, force: true });
  }
});

test("некоректна конфігурація: сервер не стартує, виводить усі проблеми", async () => {
  const server = startServer({ PORT: "abc", MAX_ROOMS: "-1" });
  try {
    const { code } = await server.exited;
    assert.equal(code, 1);
    assert.match(server.output(), /PORT/);
    assert.match(server.output(), /MAX_ROOMS/);
  } finally {
    rmSync(server.logDir, { recursive: true, force: true });
  }
});
