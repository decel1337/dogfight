import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const MIME: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ndjson": "application/x-ndjson",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};

export const mimeFor = (file: string): string =>
  MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";

// Повертає абсолютний шлях усередині root або null, якщо шлях небезпечний.
// Захист від path traversal: декодуємо, відкидаємо NUL і виходимо з root.
export function resolveSafe(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;

  const target = path.resolve(root, `.${path.posix.normalize(`/${decoded}`)}`);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (target !== root && !target.startsWith(rootWithSep)) return null;
  return target;
}

// Файли з хешем у назві (Vite: index-AbC123xy.js) незмінні, решту
// браузер має перевіряти.
function cacheControl(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".html" || path.basename(file) === "sw.js") return "no-cache";
  if (/-[\w-]{8,}\.\w+$/.test(path.basename(file))) {
    return "public, max-age=31536000, immutable";
  }
  return "public, max-age=300";
}

export async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  pathname: string,
): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" }).end();
    return;
  }

  let file = resolveSafe(root, pathname);
  if (file === null) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  let info = await stat(file).catch(() => null);
  if (info?.isDirectory()) {
    file = path.join(file, "index.html");
    info = await stat(file).catch(() => null);
  }
  if (!info?.isFile()) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  res.writeHead(200, {
    "content-type": mimeFor(file),
    "content-length": String(info.size),
    "cache-control": cacheControl(file),
    "x-content-type-options": "nosniff",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  await pipeline(createReadStream(file), res);
}
