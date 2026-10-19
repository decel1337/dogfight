// ---------- Помилки ----------

export class HttpError extends Error {
  constructor(url, status, statusText) {
    super(`HTTP ${status} ${statusText} (${url})`);
    this.name = "HttpError";
    this.url = url;
    this.status = status;
  }
}

// Дані дійшли, але зіпсовані (битий JSON, нерозкодоване аудіо).
// Повторний запит дасть те саме, тому retry для них вимкнено.
export class BadPayloadError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "BadPayloadError";
    this.retryable = false;
  }
}

// ---------- Допоміжне ----------

export function withTimeout(signal, timeoutMs) {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  return AbortSignal.any(signals);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// Повторюємо лише те, що може минути саме: мережу, таймаут, 5xx.
// Не повторюємо: 4xx, зіпсовані дані та явне скасування користувачем.
function isRetryable(error, signal) {
  if (signal?.aborted) return false;
  if (error?.retryable === false) return false;
  if (error instanceof HttpError) return error.status >= 500;
  return true;
}

// Експоненційний backoff із повним jitter: затримка — випадкова в
// [0, min(maxMs, baseMs * 2^attempt)].
export async function withRetry(
  task,
  {
    retries = 2,
    baseMs = 200,
    maxMs = 2000,
    signal,
    random = Math.random,
    wait = sleep,
    onRetry,
  } = {},
) {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await task(attempt);
    } catch (error) {
      if (attempt >= retries || !isRetryable(error, signal)) throw error;
      const delay = random() * Math.min(maxMs, baseMs * 2 ** attempt);
      onRetry?.({ attempt: attempt + 1, delay, error });
      await wait(delay, signal);
    }
  }
}

// ---------- Мережа ----------

// fetch НЕ відхиляється на 404/500, тому ok перевіряємо вручну.
async function fetchOk(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new HttpError(url, response.status, response.statusText);
  }
  return response;
}

// Читання тіла — другий асинхронний крок, і він теж може бути перерваний.
export async function fetchJson(url, { signal } = {}) {
  const response = await fetchOk(url, signal);
  try {
    return await response.json();
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new BadPayloadError(`Некоректний JSON: ${url}`, error);
  }
}

export async function fetchBytes(url, { signal } = {}) {
  const response = await fetchOk(url, signal);
  return response.arrayBuffer();
}

// JSON із таймаутом на кожну спробу та повторами.
export function requestJson(
  url,
  { signal, timeoutMs = 5000, retries = 2, ...retryOptions } = {},
) {
  return withRetry(
    () => fetchJson(url, { signal: withTimeout(signal, timeoutMs) }),
    { retries, signal, ...retryOptions },
  );
}

// ---------- Завантажувачі ассетів ----------

export function loadImage(url, { signal, timeoutMs = 8000, retries = 2 } = {}) {
  return withRetry(
    async () => {
      const bytes = await fetchBytes(url, {
        signal: withTimeout(signal, timeoutMs),
      });
      try {
        return await createImageBitmap(new Blob([bytes]));
      } catch (error) {
        throw new BadPayloadError(`Некоректне зображення: ${url}`, error);
      }
    },
    { retries, signal },
  );
}

export function loadSound(
  url,
  audioCtx,
  { signal, timeoutMs = 8000, retries = 2 } = {},
) {
  return withRetry(
    async () => {
      const bytes = await fetchBytes(url, {
        signal: withTimeout(signal, timeoutMs),
      });
      try {
        // Декодуємо під час завантаження, а не в момент першого пострілу.
        return await audioCtx.decodeAudioData(bytes);
      } catch (error) {
        throw new BadPayloadError(`Некоректне аудіо: ${url}`, error);
      }
    },
    { retries, signal },
  );
}

function normalizeImage(entry) {
  return typeof entry === "string" ? { url: entry } : entry;
}

// Збирає список завдань із маніфесту. loaders підміняються в тестах.
function buildTasks(manifest, audioCtx, loaders, options) {
  const tasks = [];
  for (const [key, entry] of Object.entries(manifest.images ?? {})) {
    const meta = normalizeImage(entry);
    tasks.push({
      group: "images",
      key,
      url: meta.url,
      run: async () => ({ ...meta, image: await loaders.image(meta.url, options) }),
    });
  }
  for (const [key, url] of Object.entries(manifest.sounds ?? {})) {
    tasks.push({
      group: "sounds",
      key,
      url,
      run: () => loaders.sound(url, audioCtx, options),
    });
  }
  return tasks;
}

export const defaultLoaders = { image: loadImage, sound: loadSound };

// Конкурентне завантаження з реальним прогресом.
// Збій окремого ассета не валить усе: він потрапляє в `failed`, а гра
// використає запасний варіант. Скасування (abort) — навпаки, перериває все.
export async function loadAll(
  manifestUrl,
  {
    audioCtx,
    signal,
    onProgress,
    sequential = false,
    loaders = defaultLoaders,
  } = {},
) {
  const startedAt = performance.now();
  const manifest = await requestJson(manifestUrl, { signal });
  const tasks = buildTasks(manifest, audioCtx, loaders, { signal });

  const result = {
    images: {},
    sounds: {},
    arena: manifest.arena ?? null,
    failed: [],
  };
  let done = 0;

  const runTask = async (task) => {
    try {
      result[task.group][task.key] = await task.run();
    } catch (error) {
      if (signal?.aborted) throw error;
      result.failed.push({ key: task.key, url: task.url, error });
    }
    onProgress?.(++done, tasks.length, task.key);
  };

  onProgress?.(0, tasks.length, null);
  if (sequential) {
    for (const task of tasks) await runTask(task);
  } else {
    await Promise.all(tasks.map(runTask));
  }

  result.ms = performance.now() - startedAt;
  return result;
}
