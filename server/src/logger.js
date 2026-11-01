// Мінімальний логер: рядок на подію, помилки — у stderr.
export function createLogger({
  out = process.stdout,
  err = process.stderr,
} = {}) {
  const write = (stream, level, message, meta) => {
    const tail = meta === undefined ? "" : ` ${JSON.stringify(meta)}`;
    stream.write(`${new Date().toISOString()} ${level} ${message}${tail}\n`);
  };
  return {
    info: (message, meta) => write(out, "INFO", message, meta),
    warn: (message, meta) => write(err, "WARN", message, meta),
    error: (message, meta) => write(err, "ERROR", message, meta),
  };
}

export const silentLogger = {
  info() {},
  warn() {},
  error() {},
};
