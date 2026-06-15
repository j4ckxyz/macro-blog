/**
 * In-memory ring buffer that captures everything written to the console
 * (Hugo build output, cross-posting, webmentions, scheduler, request logs…)
 * so it can be shown and copied from the admin "Logs" page.
 */
export interface LogEntry {
  ts: string;
  level: string;
  msg: string;
}

const BUFFER: LogEntry[] = [];
const MAX = 1000;
let installed = false;

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function fmt(arg: unknown): string {
  if (typeof arg === "string") return arg;
  try {
    return typeof arg === "object" ? JSON.stringify(arg) : String(arg);
  } catch {
    return String(arg);
  }
}

function record(level: string, args: unknown[]): void {
  const msg = stripAnsi(args.map(fmt).join(" ")).trimEnd();
  BUFFER.push({ ts: new Date().toISOString(), level, msg });
  if (BUFFER.length > MAX) BUFFER.splice(0, BUFFER.length - MAX);
}

export function getLogs(): LogEntry[] {
  return BUFFER.slice();
}

export function getLogsText(): string {
  return BUFFER.map((e) => `${e.ts} [${e.level}] ${e.msg}`).join("\n");
}

export function clearLogs(): void {
  BUFFER.length = 0;
}

/** Record a line directly (also useful in tests). */
export function logLine(level: string, msg: string): void {
  record(level, [msg]);
}

/**
 * Patch console.* so every log is also captured into the buffer. Installed once
 * from the server entry point (not in tests).
 */
export function installConsoleCapture(): void {
  if (installed) return;
  installed = true;
  const orig = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  };
  (["log", "info", "warn", "error", "debug"] as const).forEach((m) => {
    (console as any)[m] = (...args: unknown[]) => {
      try {
        record(m, args);
      } catch {
        /* never let logging break the app */
      }
      (orig as any)[m](...args);
    };
  });
}
