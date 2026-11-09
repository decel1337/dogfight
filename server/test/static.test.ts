import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { mimeFor, resolveSafe } from "../src/static.ts";
import { withApp } from "./helpers.ts";

const ROOT = path.resolve("/srv/app/dist");

test("resolveSafe: звичайні шляхи лишаються всередині root", () => {
  assert.equal(resolveSafe(ROOT, "/index.html"), path.join(ROOT, "index.html"));
  assert.equal(
    resolveSafe(ROOT, "/assets/a.js"),
    path.join(ROOT, "assets/a.js"),
  );
  assert.equal(resolveSafe(ROOT, "/"), ROOT);
});

test("resolveSafe: path traversal відхиляється", () => {
  const attacks = [
    "/../secret",
    "/../../etc/passwd",
    "/%2e%2e/secret",
    "/..%2f..%2fetc/passwd",
    "/assets/../../secret",
    "/%00",
    "/a\0b",
    "/%E0%A4%A", // некоректне %-кодування
    "/dist-evil/../../x",
  ];
  for (const attack of attacks) {
    const resolved = resolveSafe(ROOT, attack);
    const inside =
      resolved === null ||
      resolved === ROOT ||
      resolved.startsWith(ROOT + path.sep);
    assert.ok(inside, `${attack} -> ${resolved}`);
  }
});

test("resolveSafe: сусідній каталог із тим самим префіксом не проходить", () => {
  // /srv/app/dist-evil починається з "/srv/app/dist", але це інший каталог.
  // Перевірка startsWith без роздільника пропустила б його.
  const resolved = resolveSafe(ROOT, "/../dist-evil/x");
  assert.ok(resolved === null || resolved.startsWith(ROOT + path.sep));
  assert.notEqual(resolved, path.resolve("/srv/app/dist-evil/x"));
});

test("mimeFor: правильні типи", () => {
  assert.match(mimeFor("a.html"), /^text\/html/);
  assert.match(mimeFor("a.js"), /^text\/javascript/);
  assert.equal(mimeFor("a.png"), "image/png");
  assert.equal(mimeFor("a.wav"), "audio/wav");
  assert.equal(mimeFor("a.unknown"), "application/octet-stream");
});

test("HTTP static: віддає файли з MIME, блокує traversal, 404, 405", async () => {
  await withApp({}, async ({ http, staticDir }) => {
    mkdirSync(path.join(staticDir, "assets"));
    writeFileSync(path.join(staticDir, "index.html"), "<h1>hi</h1>");
    writeFileSync(
      path.join(staticDir, "assets", "app-AbCdEf123.js"),
      "export {}",
    );
    writeFileSync(path.join(staticDir, "..", "outside-secret.txt"), "secret");

    const index = await fetch(`${http}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(await index.text(), "<h1>hi</h1>");

    const js = await fetch(`${http}/assets/app-AbCdEf123.js`);
    assert.match(js.headers.get("content-type") ?? "", /javascript/);
    assert.match(js.headers.get("cache-control") ?? "", /immutable/);

    assert.equal((await fetch(`${http}/nope.js`)).status, 404);

    // fetch нормалізує "..", тому надсилаємо сирий запит через http.request
    const { request } = await import("node:http");
    const raw = (
      urlPath: string,
    ): Promise<{ status: number | undefined; body: string }> =>
      new Promise((resolve, reject) => {
        const { port } = new URL(http);
        const req = request(
          { host: "127.0.0.1", port, path: urlPath },
          (res) => {
            let body = "";
            res.on("data", (c: Buffer) => (body += c));
            res.on("end", () => resolve({ status: res.statusCode, body }));
          },
        );
        req.on("error", reject);
        req.end();
      });
    for (const attack of [
      "/../outside-secret.txt",
      "/%2e%2e/outside-secret.txt",
      "/..%2foutside-secret.txt",
    ]) {
      const result = await raw(attack);
      assert.ok(
        result.status === 403 || result.status === 404,
        `${attack}: ${result.status}`,
      );
      assert.notEqual(result.body, "secret");
    }

    const post = await fetch(`${http}/index.html`, { method: "POST" });
    assert.equal(post.status, 405);
  });
});

test("PWA: manifest віддається з правильним MIME, sw.js не кешується", async () => {
  await withApp({}, async (ctx) => {
    writeFileSync(path.join(ctx.staticDir, "manifest.webmanifest"), "{}");
    writeFileSync(path.join(ctx.staticDir, "sw.js"), "// sw");
    const manifest = await fetch(`${ctx.http}/manifest.webmanifest`);
    assert.match(
      manifest.headers.get("content-type") ?? "",
      /^application\/manifest\+json/,
    );
    const sw = await fetch(`${ctx.http}/sw.js`);
    assert.equal(sw.headers.get("cache-control"), "no-cache");
  });
});
