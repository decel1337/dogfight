import assert from "node:assert/strict";
import type http from "node:http";
import { CLOSE } from "@dogfight/shared/protocol";
import { test } from "vitest";
import {
  ConnectionCounter,
  clientIp,
  isOriginAllowed,
} from "../src/security.ts";
import { connect, createRoom, joined, sleep, withApp } from "./helpers.ts";

// ---- security.ts: чисті функції ----

test("isOriginAllowed: без Origin (не браузер) дозволено", () => {
  assert.equal(isOriginAllowed(undefined, "game.example.com", []), true);
});

test("isOriginAllowed: same-origin за Host, чужий Origin заборонено", () => {
  assert.equal(
    isOriginAllowed("https://game.example.com", "game.example.com", []),
    true,
  );
  assert.equal(
    isOriginAllowed("https://evil.example.org", "game.example.com", []),
    false,
  );
  // той самий хост, але інший порт — інший origin
  assert.equal(
    isOriginAllowed("http://game.example.com:8080", "game.example.com", []),
    false,
  );
  assert.equal(isOriginAllowed("null", "game.example.com", []), false);
  assert.equal(isOriginAllowed("не url", "game.example.com", []), false);
});

test("isOriginAllowed: список ALLOWED_ORIGINS (без урахування регістру й слеша)", () => {
  const allowed = ["https://dogfight.example.com"];
  assert.equal(
    isOriginAllowed("https://Dogfight.Example.com/", "internal:3000", allowed),
    true,
  );
  assert.equal(
    isOriginAllowed("https://other.example.com", "internal:3000", allowed),
    false,
  );
});

test("clientIp: X-Forwarded-For довіряємо лише з TRUST_PROXY і беремо останній елемент", () => {
  const req = {
    headers: { "x-forwarded-for": "6.6.6.6, 1.2.3.4" },
    socket: { remoteAddress: "10.0.0.1" },
  } as unknown as http.IncomingMessage;
  assert.equal(clientIp(req, false), "10.0.0.1");
  assert.equal(clientIp(req, true), "1.2.3.4"); // 6.6.6.6 клієнт міг підробити
  const bare = {
    headers: {},
    socket: { remoteAddress: "10.0.0.1" },
  } as unknown as http.IncomingMessage;
  assert.equal(clientIp(bare, true), "10.0.0.1");
});

test("ConnectionCounter: ліміт, release звільняє слот, ключі не течуть", () => {
  const counter = new ConnectionCounter(2);
  assert.equal(counter.acquire("a"), true);
  assert.equal(counter.acquire("a"), true);
  assert.equal(counter.acquire("a"), false);
  assert.equal(counter.acquire("b"), true, "інший ключ має власний ліміт");
  counter.release("a");
  assert.equal(counter.acquire("a"), true);
  counter.release("a");
  counter.release("a");
  counter.release("b");
  assert.equal(counter.keys, 0);
  counter.release("a"); // зайвий release безпечний
  assert.equal(counter.keys, 0);
});

// ---- конфіг ----

test("config: production-налаштування за замовчуванням і парсинг", async () => {
  const { loadConfig } = await import("../src/config.ts");
  const d = loadConfig({});
  assert.equal(d.logLevel, "info");
  assert.deepEqual(d.allowedOrigins, []);
  assert.equal(d.maxConnectionsPerIp, 20);
  assert.equal(d.trustProxy, false);
  assert.equal(d.gitSha, "dev");
  const c = loadConfig({
    LOG_LEVEL: "debug",
    ALLOWED_ORIGINS: "https://a.example.com/, https://b.example.com",
    MAX_CONNECTIONS_PER_IP: "5",
    TRUST_PROXY: "1",
    GIT_SHA: "abc1234",
  });
  assert.equal(c.logLevel, "debug");
  assert.deepEqual(c.allowedOrigins, [
    "https://a.example.com",
    "https://b.example.com",
  ]);
  assert.equal(c.maxConnectionsPerIp, 5);
  assert.equal(c.trustProxy, true);
  assert.throws(() => loadConfig({ LOG_LEVEL: "verbose" }), /LOG_LEVEL/);
});

// ---- Origin на реальному сервері ----

test("WS: чужий Origin -> 403, свій/відсутній -> ок, метрика відхилень росте", async () => {
  await withApp({}, async (ctx) => {
    const room = await createRoom(ctx);

    const evil = connect(ctx.wsUrl, {
      headers: { origin: "https://evil.example.org" },
    });
    await assert.rejects(evil.opened, /403/);

    const same = connect(ctx.wsUrl, { headers: { origin: ctx.http } });
    await same.opened;
    same.ws.close();

    const bot = await joined(ctx, room.id, "NoOrigin"); // Origin відсутній
    bot.ws.close();

    const text = await (await fetch(`${ctx.http}/metrics`)).text();
    assert.match(text, /dogfight_rejections_total\{reason="origin"\} 1/);
  });
});

test("WS: ALLOWED_ORIGINS пропускає вказаний origin", async () => {
  await withApp(
    { ALLOWED_ORIGINS: "https://dogfight.example.com" },
    async (ctx) => {
      const ok = connect(ctx.wsUrl, {
        headers: { origin: "https://dogfight.example.com" },
      });
      await ok.opened;
      ok.ws.close();
      const bad = connect(ctx.wsUrl, {
        headers: { origin: "https://evil.example.org" },
      });
      await assert.rejects(bad.opened, /403/);
    },
  );
});

// ---- ліміт з'єднань на IP ----

test("WS: ліміт з'єднань з одного IP -> 429, слот звільняється після закриття", async () => {
  await withApp({ MAX_CONNECTIONS_PER_IP: "2" }, async (ctx) => {
    const a = connect(ctx.wsUrl);
    const b = connect(ctx.wsUrl);
    await Promise.all([a.opened, b.opened]);

    const c = connect(ctx.wsUrl);
    await assert.rejects(c.opened, /429/);

    a.ws.close();
    await a.closed;
    await sleep(30);
    const d = connect(ctx.wsUrl);
    await d.opened; // слот знову вільний
    d.ws.close();
    b.ws.close();

    const text = await (await fetch(`${ctx.http}/metrics`)).text();
    assert.match(text, /dogfight_rejections_total\{reason="ip_limit"\} 1/);
  });
});

test("WS: за TRUST_PROXY ліміт рахується по X-Forwarded-For, а не по IP проксі", async () => {
  await withApp(
    { MAX_CONNECTIONS_PER_IP: "1", TRUST_PROXY: "1" },
    async (ctx) => {
      const a = connect(ctx.wsUrl, {
        headers: { "x-forwarded-for": "1.1.1.1" },
      });
      const b = connect(ctx.wsUrl, {
        headers: { "x-forwarded-for": "2.2.2.2" },
      });
      await Promise.all([a.opened, b.opened]);
      const again = connect(ctx.wsUrl, {
        headers: { "x-forwarded-for": "1.1.1.1" },
      });
      await assert.rejects(again.opened, /429/);
      a.ws.close();
      b.ws.close();
    },
  );
});

// ---- health / ready / metrics ----

test("/health: версія й sha; /ready: 200, а після початку stop — не готовий", async () => {
  await withApp({ GIT_SHA: "abc1234", APP_VERSION: "1.2.3" }, async (ctx) => {
    const health = (await (await fetch(`${ctx.http}/health`)).json()) as Record<
      string,
      unknown
    >;
    assert.equal(health.status, "ok");
    assert.equal(health.version, "1.2.3");
    assert.equal(health.sha, "abc1234");

    const ready = await fetch(`${ctx.http}/ready`);
    assert.equal(ready.status, 200);
    assert.equal(ctx.app.ready, true);

    const stopping = ctx.app.stop();
    assert.equal(
      ctx.app.ready,
      false,
      "readiness знімається ДО закриття сокетів",
    );
    await stopping;
  });
});

test("/metrics: формат Prometheus, ключові метрики, ENABLE_METRICS=0 вимикає", async () => {
  await withApp({}, async (ctx) => {
    const room = await createRoom(ctx);
    const player = await joined(ctx, room.id, "Metr");
    await sleep(120);
    const res = await fetch(`${ctx.http}/metrics`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^text\/plain/);
    const text = await res.text();
    for (const name of [
      "dogfight_connections 1",
      "dogfight_players 1",
      "dogfight_rooms 1",
      "dogfight_messages_in_total",
      "dogfight_bytes_out_total",
      "dogfight_tick_work_p99_ms",
      "dogfight_event_loop_utilization",
    ]) {
      assert.ok(text.includes(name), `немає ${name}`);
    }
    player.ws.close();
  });
  await withApp({ ENABLE_METRICS: "0" }, async (ctx) => {
    assert.equal((await fetch(`${ctx.http}/metrics`)).status, 404);
  });
});

// ---- graceful shutdown: повідомлення клієнту ----

test("stop(): клієнт отримує shutdown, потім закриття 1001; нові WS відхиляються", async () => {
  await withApp({}, async (ctx) => {
    const room = await createRoom(ctx);
    const player = await joined(ctx, room.id, "Pilot");
    const stopping = ctx.app.stop();
    const notice = await player.next("shutdown");
    assert.equal(notice.reconnectMs, 5000);
    assert.equal((await player.closed).code, CLOSE.GOING_AWAY);
    await stopping;
  });
});
