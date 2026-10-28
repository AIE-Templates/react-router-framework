/**
 * The main process log: JSON lines on stdout, like the server's pino output, without pino itself
 * (the main entry is a CommonJS bundle and must stay small). The utility process logs through
 * @repo/server's logger; its output is forwarded here as is.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(data: Record<string, unknown>, msg: string): void;
  info(data: Record<string, unknown>, msg: string): void;
  warn(data: Record<string, unknown>, msg: string): void;
  error(data: Record<string, unknown>, msg: string): void;
}

const levels: LogLevel[] = ["debug", "info", "warn", "error"];

export function createLogger(minimum: LogLevel = "info"): Logger {
  const threshold = levels.indexOf(minimum);
  const write = (level: LogLevel, data: Record<string, unknown>, msg: string) => {
    if (levels.indexOf(level) < threshold) return;
    const line = JSON.stringify({ level, time: new Date().toISOString(), process: "main", ...serializable(data), msg });
    process.stdout.write(line + "\n");
  };
  return {
    debug: (data, msg) => write("debug", data, msg),
    info: (data, msg) => write("info", data, msg),
    warn: (data, msg) => write("warn", data, msg),
    error: (data, msg) => write("error", data, msg),
  };
}

function serializable(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    out[key] = value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value;
  }
  return out;
}
