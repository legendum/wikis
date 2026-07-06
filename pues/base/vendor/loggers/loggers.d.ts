/**
 * Type declarations for the hand-written Loggers SDK (`public/loggers.js`).
 *
 * `public/` is outside the typecheck `include`, so under `strict` the
 * `import { Loggers } from "../../public/loggers.js"` would be an implicit
 * `any` (TS7016). This sibling `.d.ts` gives it real types — same pattern
 * as `pues/base/vendor/legendum/legendum.js` + `legendum.d.ts`.
 */

/** Levels a line can be emitted at. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** Minimum-level threshold; `"silent"` suppresses all output. */
export type LogThreshold = LogLevel | "silent";

export interface LoggerLocalOptions {
  /** Set false to disable the local file sink. */
  enabled?: boolean;
  /** Directory for `<dir>/<name>/<YYYY-MM-DD>.log` files. */
  dir?: string;
  /** Days to keep local log files; 0 disables retention cleanup. */
  retentionDays?: number;
  /** IANA timezone for day-bucketing local files (default "UTC"). */
  timezone?: string;
}

export interface LoggerOptions {
  /** Logger alias; resolved to a ULID via env/config. */
  name?: string;
  /** Explicit logger ULID (skips name resolution). */
  ulid?: string;
  /** Source component tag applied to each line (default "app"). */
  component?: string;
  /** Minimum level to emit (default "info"; may be raised by env/config). */
  level?: LogThreshold;
  /** Local file sink: `true` for defaults, or an options object. */
  local?: boolean | LoggerLocalOptions;
  /** Ingest base URL (default https://loggers.dev). */
  endpoint?: string;
  /** Background flush interval in ms (min 10000, default 20000). */
  flushIntervalMs?: number;
  /** Max queued lines before an eager flush (default 500). */
  batchSize?: number;
  /** Convenience alias for `local.retentionDays`. */
  fileRetentionDays?: number;
}

export interface Logger {
  debug(data: Record<string, unknown>, component?: string): void;
  info(data: Record<string, unknown>, component?: string): void;
  warn(data: Record<string, unknown>, component?: string): void;
  error(data: Record<string, unknown>, component?: string): void;
  /**
   * A bound logger that tags lines with `component` by default. Shares the
   * parent's queue, batching, level, and local sink (not a new handle).
   */
  child(component: string): Logger;
  /** Change the minimum emit level at runtime. Returns the logger. */
  setLevel(level: LogThreshold): Logger;
  /** Retarget the local sink's base directory; affects future lines only. */
  setDir(dir: string): Logger;
  /** Send queued lines to the remote sink and drain local writes. */
  flush(): Promise<void>;
  /** Flush, then stop the background flush timer. */
  close(): Promise<void>;
}

/** @deprecated alias for {@link Logger}. */
export type LoggerHandle = Logger;

export const Loggers: {
  /** SDK version string (semver). */
  version: string;
  create(options: LoggerOptions): Logger;
};
