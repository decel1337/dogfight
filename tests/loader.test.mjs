import assert from "node:assert/strict";
import { createServer } from "node:http";
import test, { after, before } from "node:test";
import {
  BadPayloadError,
  HttpError,
  fetchBytes,
  fetchJson,
  loadAll,
  requestJson,
  withRetry,
} from "../src/assets/loader.js";
import { Lobby } from "../src/lobby/lobby.js";

let server;
let base;
const hits = new Map();
const hit = (path) => hits.set(path, (hits.get(path) ?? 0) + 1).get(path);

before(async () => {
  server = createServer((req, res) => {
    const n = hit(req.url);
    const json = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(body);
    };
    if (req.url === "/ok.json") return json(200, '{"a":1}');
    if (req.url === "/missing.json") return json(404, '{"error":"nope"}');
    if (req.url === "/bad.json") return json(200, "{not json");
    if (req.url === "/flaky.json") {
      return n < 3 ? json(503, "{}") : json(200, '{"ok":true}');
    }
    if (req.url === "/hang") return; // ніколи не відповідає
    if (req.url.startsWith("/slow/")) {
      const ms = Number(req.url.split("/")[2]);
      return setTimeout(() => json(200, `{"ms":${ms}}`), ms);
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

const noWait = () => Promise.resolve();

test("fetchJson: перевіряє ok (404 -> HttpError)", async () => {
  await assert.rejects(fetchJson(`${base}/missing.json`), (e) => {
    assert.ok(e instanceof HttpError);
    assert.equal(e.status, 404);
    return true;
  });
  assert.deepEqual(await fetchJson(`${base}/ok.json`), { a: 1 });
});

test("fetchJson: битий JSON -> BadPayloadError", async () => {
  await assert.rejects(fetchJson(`${base}/bad.json`), BadPayloadError);
});

test("withRetry: 4xx не повторюється, 5xx — повторюється", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(() => (calls++, Promise.reject(new HttpError("u", 404, "NF"))), {
      wait: noWait,
    }),
    HttpError,
  );
  assert.equal(calls, 1);

  calls = 0;
  const value = await withRetry(
    () => {
      calls++;
      if (calls < 3) throw new HttpError("u", 503, "SU");
      return "ok";
    },
    { retries: 2, wait: noWait },
  );
  assert.equal(value, "ok");
  assert.equal(calls, 3);
});

test("withRetry: backoff експоненційний, jitter у межах [0, ліміт]", async () => {
  const delays = [];
  await assert.rejects(
    withRetry(() => Promise.reject(new TypeError("net")), {
      retries: 4,
      baseMs: 100,
      maxMs: 500,
      random: () => 1,
      wait: (ms) => (delays.push(ms), Promise.resolve()),
    }),
    TypeError,
  );
  assert.deepEqual(delays, [100, 200, 400, 500]);

  const low = [];
  await assert.rejects(
    withRetry(() => Promise.reject(new TypeError("net")), {
      retries: 2,
      baseMs: 100,
      random: () => 0,
      wait: (ms) => (low.push(ms), Promise.resolve()),
    }),
  );
  assert.deepEqual(low, [0, 0]);
});

test("withRetry: скасування зупиняє повтори", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    withRetry(
      () => {
        calls++;
        controller.abort();
        return Promise.reject(new TypeError("net"));
      },
      { retries: 5, signal: controller.signal, wait: noWait },
    ),
  );
  assert.equal(calls, 1);
});

test("requestJson: 503, 503, 200 -> успіх після двох повторів", async () => {
  const data = await requestJson(`${base}/flaky.json`, {
    retries: 2,
    baseMs: 1,
  });
  assert.deepEqual(data, { ok: true });
  assert.equal(hits.get("/flaky.json"), 3);
});

test("requestJson: таймаут на кожну спробу", async () => {
  await assert.rejects(
    requestJson(`${base}/hang`, { timeoutMs: 80, retries: 1, baseMs: 1 }),
    (e) => e.name === "TimeoutError",
  );
  assert.equal(hits.get("/hang"), 2, "дві спроби по 80 мс");
});

test("loadAll: прогрес реальний, збій одного ассета не валить решту", async () => {
  const loaders = {
    image: async (url, opts) => (await fetchBytes(url, opts), `img:${url}`),
    sound: async (url, _ctx, opts) => (await fetchBytes(url, opts), `snd:${url}`),
  };
  const progress = [];
  const manifest = {
    images: { a: `${base}/ok.json`, b: `${base}/missing.json` },
    sounds: { c: `${base}/ok.json` },
  };
  // Окремий міні-сервер віддає маніфест.
  const manifestServer = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(manifest));
  });
  await new Promise((r) => manifestServer.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${manifestServer.address().port}/m.json`;

  const result = await loadAll(url, {
    loaders,
    onProgress: (done, total) => progress.push([done, total]),
  });
  manifestServer.close();

  assert.deepEqual(progress.map((p) => p[0]), [0, 1, 2, 3]);
  assert.ok(progress.every((p) => p[1] === 3));
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].key, "b");
  assert.equal(result.failed[0].error.status, 404);
  assert.ok(result.images.a);
  assert.ok(result.sounds.c);
});

test("Lobby: періодичне опитування, abort при join, події", async () => {
  const signals = [];
  const rooms = [{ id: "r1", name: "One", maxPlayers: 2 }];
  const lobby = new Lobby({
    pollMs: 20,
    request: (_url, { signal }) => {
      signals.push(signal);
      return Promise.resolve(rooms);
    },
  });
  const seen = [];
  lobby.addEventListener("rooms", (e) => seen.push(e.detail));
  const joined = [];
  lobby.addEventListener("joined", (e) => joined.push(e.detail));

  lobby.start();
  await new Promise((r) => setTimeout(r, 75));
  assert.ok(seen.length >= 3, `опитувань: ${seen.length}`);

  assert.equal(lobby.join("nope", "x"), false);
  assert.equal(lobby.join("r1", "Ace"), true);
  assert.equal(joined[0].room.id, "r1");
  assert.ok(signals.every((s) => s.aborted), "запити скасовано при виході");

  const count = seen.length;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(seen.length, count, "опитування зупинено");
});

test("Lobby: помилка запиту -> подія lobby-error, опитування триває", async () => {
  let n = 0;
  const lobby = new Lobby({
    pollMs: 15,
    request: () =>
      ++n === 1 ? Promise.reject(new Error("boom")) : Promise.resolve([]),
  });
  const errors = [];
  const rooms = [];
  lobby.addEventListener("lobby-error", (e) => errors.push(e.detail.message));
  lobby.addEventListener("rooms", (e) => rooms.push(e.detail));
  lobby.start();
  await new Promise((r) => setTimeout(r, 60));
  lobby.stop();
  assert.deepEqual(errors, ["boom"]);
  assert.ok(rooms.length >= 1);
});
