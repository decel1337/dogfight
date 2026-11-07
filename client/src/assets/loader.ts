// ---------- Помилки ----------

export class HttpError extends Error {
  readonly url: string;
  readonly status: number;
  /** Текст помилки з тіла `{error}` відповіді сервера (лише для postJson). */
  detail: string | undefined;

  constructor(url: string, status: number, statusText: string) {
    super(`HTTP ${status} ${statusText} (${url})`);
    this.name = "HttpError";
    this.url = url;
    this.status = status;
  }
}

// Дані дійшли, але зіпсовані (битий JSON, нерозкодоване аудіо).
// Повторний запит дасть те саме, тому retry для них вимкнено.
export class BadPayloadError extends Error {
  readonly retryable = false;

  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "BadPayloadError";
  }
}

// Опції одного запиту: підписи спільні для fetch-обгорток.
export interface RequestOptions {
  signal?: AbortSignal | undefined;
  timeoutMs?: number;
}
export interface RetryOptions {
  retries?: number;
  baseMs?: number;
  maxMs?: number;
  signal?: AbortSignal | undefined;
  random?: () => number;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onRetry?: (info: { attempt: number; delay: number; error: unknown }) => void;
}

// ---------- Допоміжне ----------

export function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  return AbortSignal.any(signals);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
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
function isRetryable(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return false;
  if (error instanceof BadPayloadError) return false;
  if (error instanceof HttpError) return error.status >= 500;
  return true;
}

// Експоненційний backoff із повним jitter: затримка — випадкова в
// [0, min(maxMs, baseMs * 2^attempt)].
export async function withRetry<T>(
  task: (attempt: number) => T | Promise<T>,
  {
    retries = 2,
    baseMs = 200,
    maxMs = 2000,
    signal,
    random = Math.random,
    wait = sleep,
    onRetry,
  }: RetryOptions = {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await task(attempt);
    } catch (error: unknown) {
      if (attempt >= retries || !isRetryable(error, signal)) throw error;
      const delay = random() * Math.min(maxMs, baseMs * 2 ** attempt);
      onRetry?.({ attempt: attempt + 1, delay, error });
      await wait(delay, signal);
    }
  }
}

// ---------- Мережа ----------

// fetch НЕ відхиляється на 404/500, тому ok перевіряємо вручну.
async function fetchOk(url: string, signal: AbortSignal | undefined): Promise<Response> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new HttpError(url, response.status, response.statusText);
  }
  return response;
}

// Читання тіла — другий асинхронний крок, і він теж може бути перерваний.
export async function fetchJson(
  url: string,
  { signal }: { signal?: AbortSignal | undefined } = {},
): Promise<unknown> {
  const response = await fetchOk(url, signal);
  try {
    return await response.json();
  } catch (error: unknown) {
    if (signal?.aborted) throw error;
    throw new BadPayloadError(`Некоректний JSON: ${url}`, error);
  }
}

export async function fetchBytes(
  url: string,
  { signal }: { signal?: AbortSignal | undefined } = {},
): Promise<ArrayBuffer> {
  const response = await fetchOk(url, signal);
  return response.arrayBuffer();
}

// JSON із таймаутом на кожну спробу та повторами.
export function requestJson(
  url: string,
  { signal, timeoutMs = 5000, retries = 2, ...retryOptions }: RequestOptions & RetryOptions = {},
): Promise<unknown> {
  return withRetry(
    () => fetchJson(url, { signal: withTimeout(signal, timeoutMs) }),
    { retries, signal, ...retryOptions },
  );
}

// Текст `{error: "..."}` із тіла відповіді сервера, якщо він там є.
function errorText(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const text: unknown = Reflect.get(body, "error");
  return typeof text === "string" ? text : undefined;
}

// POST JSON із таймаутом. Повідомлення про помилку беремо з тіла `{error}`,
// якщо сервер його надіслав. Не повторюємо: POST не ідемпотентний.
export async function postJson(
  url: string,
  body: unknown,
  { signal, timeoutMs = 5000 }: RequestOptions = {},
): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: withTimeout(signal, timeoutMs),
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const detail = errorText(body);
    const error = new HttpError(url, response.status, detail ?? response.statusText);
    error.detail = detail;
    throw error;
  }
  return await response.json();
}

// ---------- Завантажувачі ассетів ----------

export interface LoadOptions extends RequestOptions {
  retries?: number;
}

export function loadImage(
  url: string,
  { signal, timeoutMs = 8000, retries = 2 }: LoadOptions = {},
): Promise<ImageBitmap> {
  return withRetry(
    async () => {
      const bytes = await fetchBytes(url, {
        signal: withTimeout(signal, timeoutMs),
      });
      try {
        return await createImageBitmap(new Blob([bytes]));
      } catch (error: unknown) {
        throw new BadPayloadError(`Некоректне зображення: ${url}`, error);
      }
    },
    { retries, signal },
  );
}

export function loadSound(
  url: string,
  audioCtx: Pick<BaseAudioContext, "decodeAudioData">,
  { signal, timeoutMs = 8000, retries = 2 }: LoadOptions = {},
): Promise<AudioBuffer> {
  return withRetry(
    async () => {
      const bytes = await fetchBytes(url, {
        signal: withTimeout(signal, timeoutMs),
      });
      try {
        // Декодуємо під час завантаження, а не в момент першого пострілу.
        return await audioCtx.decodeAudioData(bytes);
      } catch (error: unknown) {
        throw new BadPayloadError(`Некоректне аудіо: ${url}`, error);
      }
    },
    { retries, signal },
  );
}

// Маніфест ассетів (public/assets.json): картинки (рядок або об'єкт із
// метаданими), звуки й розміри арени. Приходить з мережі => перевіряється.
export interface ImageMeta {
  url: string;
  [extra: string]: unknown;
}
export interface Manifest {
  images: Record<string, string | ImageMeta>;
  sounds: Record<string, string>;
  arena: { width: number; height: number } | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseManifest(raw: unknown): Manifest {
  if (!isRecord(raw)) throw new BadPayloadError("Маніфест має бути об'єктом");
  const images: Manifest["images"] = {};
  if (raw.images !== undefined) {
    if (!isRecord(raw.images)) throw new BadPayloadError("Маніфест: images має бути об'єктом");
    for (const [key, entry] of Object.entries(raw.images)) {
      if (typeof entry === "string") images[key] = entry;
      else if (isRecord(entry) && typeof entry.url === "string") images[key] = { ...entry, url: entry.url };
      else throw new BadPayloadError(`Маніфест: некоректний запис images.${key}`);
    }
  }
  const sounds: Manifest["sounds"] = {};
  if (raw.sounds !== undefined) {
    if (!isRecord(raw.sounds)) throw new BadPayloadError("Маніфест: sounds має бути об'єктом");
    for (const [key, url] of Object.entries(raw.sounds)) {
      if (typeof url !== "string") throw new BadPayloadError(`Маніфест: некоректний запис sounds.${key}`);
      sounds[key] = url;
    }
  }
  const arena = isRecord(raw.arena) && typeof raw.arena.width === "number" && typeof raw.arena.height === "number"
    ? { width: raw.arena.width, height: raw.arena.height }
    : null;
  return { images, sounds, arena };
}

// Завантажувачі підміняються в тестах, тож їхній тип — окремий generic-контракт.
export interface Loaders<I = ImageBitmap, S = AudioBuffer> {
  image(url: string, options: LoadOptions): Promise<I>;
  sound(url: string, audioCtx: Pick<BaseAudioContext, "decodeAudioData"> | undefined, options: LoadOptions): Promise<S>;
}

export interface LoadedImage<I> {
  url: string;
  image: I;
  [extra: string]: unknown;
}

export interface FailedAsset {
  key: string;
  url: string;
  error: unknown;
}

export interface LoadResult<I, S> {
  images: Record<string, LoadedImage<I>>;
  sounds: Record<string, S>;
  arena: Manifest["arena"];
  failed: FailedAsset[];
  ms: number;
}

export const defaultLoaders: Loaders = {
  image: loadImage,
  sound: (url, audioCtx, options) => {
    if (!audioCtx) return Promise.reject(new Error("немає AudioContext"));
    return loadSound(url, audioCtx, options);
  },
};

// Конкурентне завантаження з реальним прогресом.
// Збій окремого ассета не валить усе: він потрапляє в `failed`, а гра
// використає запасний варіант. Скасування (abort) — навпаки, перериває все.
export interface LoadAllOptions {
  audioCtx?: Pick<BaseAudioContext, "decodeAudioData"> | undefined;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, key: string | null) => void;
  sequential?: boolean;
}

// Перевантаження: без `loaders` результат — справжні ImageBitmap/AudioBuffer;
// з власними завантажувачами типи ассетів виводяться з них (так тестують без
// браузера). Реалізація працює з `unknown` і не потребує приведень типів.
export function loadAll(
  manifestUrl: string,
  options?: LoadAllOptions,
): Promise<LoadResult<ImageBitmap, AudioBuffer>>;
export function loadAll<I, S>(
  manifestUrl: string,
  options: LoadAllOptions & { loaders: Loaders<I, S> },
): Promise<LoadResult<I, S>>;
export async function loadAll(
  manifestUrl: string,
  {
    audioCtx,
    signal,
    onProgress,
    sequential = false,
    loaders = defaultLoaders,
  }: LoadAllOptions & { loaders?: Loaders<unknown, unknown> } = {},
): Promise<LoadResult<unknown, unknown>> {
  const startedAt = performance.now();
  const manifest = parseManifest(await requestJson(manifestUrl, { signal }));
  const options: LoadOptions = { signal };

  const images: Record<string, LoadedImage<unknown>> = {};
  const sounds: Record<string, unknown> = {};
  const failed: FailedAsset[] = [];
  // Кожне завдання знає, куди покласти результат: це замінює «result[group][key]»
  // з відсутньою типізацією на два типізовані словники.
  const tasks: { key: string; url: string; run: () => Promise<void> }[] = [];
  for (const [key, entry] of Object.entries(manifest.images)) {
    const meta: ImageMeta = typeof entry === "string" ? { url: entry } : entry;
    tasks.push({
      key,
      url: meta.url,
      run: async () => {
        images[key] = { ...meta, image: await loaders.image(meta.url, options) };
      },
    });
  }
  for (const [key, url] of Object.entries(manifest.sounds)) {
    tasks.push({
      key,
      url,
      run: async () => {
        sounds[key] = await loaders.sound(url, audioCtx, options);
      },
    });
  }

  let done = 0;
  const runTask = async (task: (typeof tasks)[number]): Promise<void> => {
    try {
      await task.run();
    } catch (error: unknown) {
      if (signal?.aborted) throw error;
      failed.push({ key: task.key, url: task.url, error });
    }
    onProgress?.(++done, tasks.length, task.key);
  };

  onProgress?.(0, tasks.length, null);
  if (sequential) {
    for (const task of tasks) await runTask(task);
  } else {
    await Promise.all(tasks.map(runTask));
  }

  return { images, sounds, arena: manifest.arena, failed, ms: performance.now() - startedAt };
}
