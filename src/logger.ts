// JSON-lines logger on stderr. stdout belongs to the MCP stdio transport, so
// anything printed there corrupts the protocol stream.
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// Defence in depth: callers shouldn't pass secrets, but if one slips into a
// field with one of these names it never reaches a log file.
const REDACT_KEYS = new Set(["token", "proof", "secret", "authorization"]);

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

const redact = (fields: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (REDACT_KEYS.has(key.toLowerCase())) out[key] = "[redacted]";
    else if (value instanceof Error) out[key] = { name: value.name, message: value.message };
    else out[key] = value;
  }
  return out;
};

export const createLogger = (
  level: LogLevel = "info",
  base: Record<string, unknown> = {},
  sink: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Logger => {
  const threshold = LEVELS[level];
  const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (LEVELS[lvl] < threshold) return;
    sink(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: lvl,
        msg,
        ...redact({ ...base, ...fields }),
      }),
    );
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (fields) => createLogger(level, { ...base, ...fields }, sink),
  };
};

export const silentLogger: Logger = createLogger("error", {}, () => {});

export const parseLogLevel = (value: string | undefined): LogLevel =>
  value && value in LEVELS ? (value as LogLevel) : "info";
