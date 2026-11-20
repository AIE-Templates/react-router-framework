import { redactLogUrls } from "./log-url.ts";

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

/** What the logger writes to a stream through: `write` and the `error` event. */
export interface LineStream {
  write(line: string | Uint8Array): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
}

/**
 * A line sink on `stream` that never turns a failed write into an error of its own: once the stream
 * fails, typically because whoever started the app stopped reading its output (EPIPE), later lines
 * are dropped. Unhandled, that failure would surface as an uncaught exception, whose handler logs it
 * to the same stream, which fails again: the main process would spin in that loop at full CPU and
 * never finish quitting (as after Ctrl+C on `pnpm dev:desktop`, which stops reading before the app's
 * helpers, killed with it, have been logged as gone).
 */
export function streamSink(stream: LineStream): (line: string | Uint8Array) => void {
  let failed = false;
  stream.on("error", () => {
    failed = true;
  });
  return (line) => {
    if (failed) return;
    try {
      stream.write(line);
    } catch {
      failed = true;
    }
  };
}

// Install one error listener per process stream, shared across loggers and utility restarts.
let stdoutSink: ReturnType<typeof streamSink> | undefined;
let stderrSink: ReturnType<typeof streamSink> | undefined;
export function writeStdout(chunk: string | Uint8Array): void {
  (stdoutSink ??= streamSink(process.stdout))(chunk);
}

export function writeStderr(chunk: string | Uint8Array): void {
  (stderrSink ??= streamSink(process.stderr))(chunk);
}

/** `output` receives each line, newline included; by default it goes to stdout (`streamSink`). */
export function createLogger(minimum: LogLevel = "info", output: (line: string) => void = writeStdout): Logger {
  const threshold = levels.indexOf(minimum);
  const write = (level: LogLevel, data: Record<string, unknown>, msg: string) => {
    if (levels.indexOf(level) < threshold) return;
    const line = JSON.stringify({ level, time: new Date().toISOString(), process: "main", ...serializable(data), msg });
    output(line + "\n");
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
    out[key] =
      value instanceof Error
        ? { name: value.name, message: redactLogUrls(value.message), stack: value.stack && redactLogUrls(value.stack) }
        : value;
  }
  return out;
}
