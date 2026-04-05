import { appendFileSync, mkdirSync, existsSync } from "fs";
import { resolve } from "path";
import { LOG_DIR, LOG_LEVEL } from "./constants";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

const minLevel = LEVELS[LOG_LEVEL as Level] ?? LEVELS.info;

function logFile(): string {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  return resolve(LOG_DIR, `${date}.log`);
}

function write(level: Level, msg: string, data?: Record<string, unknown>) {
  if (LEVELS[level] < minLevel) return;

  const line = JSON.stringify({
    t: new Date().toISOString(),
    l: level,
    msg,
    ...data,
  });

  appendFileSync(logFile(), line + "\n");
}

export const log = {
  debug: (msg: string, data?: Record<string, unknown>) => write("debug", msg, data),
  info: (msg: string, data?: Record<string, unknown>) => write("info", msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => write("warn", msg, data),
  error: (msg: string, data?: Record<string, unknown>) => write("error", msg, data),
};
