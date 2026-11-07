// Мінімальний логер: рядок на подію, помилки — у stderr.
export type LogMeta = Record<string, unknown>;

export interface Logger {
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, meta?: LogMeta): void;
}

export function createLogger({
  out = process.stdout,
  err = process.stderr,
}: { out?: NodeJS.WritableStream; err?: NodeJS.WritableStream } = {}): Logger {
  const write = (
    stream: NodeJS.WritableStream,
    level: string,
    message: string,
    meta: LogMeta | undefined,
  ): void => {
    const tail = meta === undefined ? "" : ` ${JSON.stringify(meta)}`;
    stream.write(`${new Date().toISOString()} ${level} ${message}${tail}\n`);
  };
  return {
    info: (message, meta) => write(out, "INFO", message, meta),
    warn: (message, meta) => write(err, "WARN", message, meta),
    error: (message, meta) => write(err, "ERROR", message, meta),
  };
}

export const silentLogger: Logger = {
  info() {},
  warn() {},
  error() {},
};
