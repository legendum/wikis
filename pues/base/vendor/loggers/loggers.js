/**
 * Loggers SDK — a tiny, dependency-free client for shipping structured log
 * lines to a Loggers endpoint, with an optional local-file fallback.
 *
 * Runtime: server-side JavaScript only — Node, Bun, and Deno (via its `node:`
 * builtin support). It statically imports `node:fs` / `node:path` and uses the
 * global `fetch` for remote ingest. No npm packages required. For a browser
 * build, make a separate version.
 *
 * ── Quick start ────────────────────────────────────────────────────────────
 *
 *   import { Loggers } from "./loggers.js";
 *
 *   const log = Loggers.create({
 *     ulid: "01HXXXXXXXXXXXXXXXXXXXXXXX",  // target logger (26-char ULID)
 *     component: "api",                    // tags every line; default "app"
 *   });
 *
 *   log.info({ msg: "server started", port: 3000 });
 *   log.warn({ msg: "slow query", ms: 1200 });
 *   log.error({ msg: "boom", err: String(error) }, "worker"); // 2nd arg = per-line component
 *
 *   await log.close(); // flush + stop the timer on shutdown
 *
 * Each `debug` / `info` / `warn` / `error` call is synchronous and returns
 * immediately: it takes a data value (an object is sent as-is; anything else is
 * wrapped as `{ value }`) and an optional component override. The data is
 * serialized at call time, so later mutation of the object isn't logged. Lines are
 * buffered and written in batches — appended to the local file and/or POSTed to
 * the remote endpoint — on a timer, when a batch fills, or on flush()/close().
 * Buffered lines are durable only after the next flush (default 20s) or a
 * graceful close(); wire close() into your shutdown path to avoid losing them.
 *
 * ── Identifying the logger ─────────────────────────────────────────────────
 *
 * Provide one of:
 *   - `ulid`: the logger's 26-char ULID (enables remote ingest directly), or
 *   - `name`: a human alias resolved to a ULID via, in order:
 *       1. env LOGGERS_NAME (must equal `name`) + LOGGERS_ULID
 *       2. a `loggers.yaml` entry (see below)
 *     If no valid ULID resolves, remote ingest is disabled and the SDK falls
 *     back to local-only (a diagnostic warn line is written locally).
 *
 * The logger's ULID is copied from loggers.dev. Email kevin@legendum.co.uk
 * with questions.
 *
 * ── Options (all optional unless noted) ────────────────────────────────────
 *
 *   name              Alias to resolve to a ULID (see above).
 *   ulid              26-char ULID; required if no `name`/config resolves one.
 *   component         Default component tag for lines. Default "app".
 *   level             Min level: "debug" | "info" | "warn" | "error" |
 *                     "silent" (suppresses all output). Precedence: this
 *                     option > env LOGGERS_LEVEL > config default_level > "info".
 *   endpoint          Ingest base URL. Default "https://loggers.dev".
 *   flushIntervalMs   Auto-flush interval. Clamped to >= 10_000. Default 20_000.
 *   batchSize         Max lines per POST / queue trigger. Default 500.
 *   local             true, or { enabled, dir, timezone, retentionDays } to
 *                     also write JSONL files at <dir>/<name>/<YYYY-MM-DD>.log.
 *   fileRetentionDays Days of local log files to keep (prunes older). Enabling
 *                     retention (> 0) turns the local sink on.
 *
 * ── Config file (loggers.yaml) ─────────────────────────────────────────────
 *
 * Searched in order: env LOGGERS_CONFIG_PATH, ./loggers.yaml,
 * ~/.config/loggers/loggers.yaml. Read synchronously at construction. Shape:
 *
 *   timezone: UTC
 *   default_level: info
 *   loggers:
 *     my-service:
 *       ulid: 01HXXXXXXXXXXXXXXXXXXXXXXX
 *       level: debug
 *       file_retention_days: 7
 *
 * Methods on the handle: debug/info/warn/error(data, component?),
 * child(component), setLevel(level), setDir(dir), flush(), close(). A child
 * shares the parent's queue/level/sink and just tags lines with its component.
 * Note: no client IP is ever attached to log lines. The SDK version is exposed
 * as `Loggers.version`.
 */
import { readFileSync } from "node:fs";
import { appendFile, mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i;
const LEVEL_RANK = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  // A threshold only: no method emits "silent", so as a min level it sits
  // above every real line and suppresses all output.
  silent: Number.POSITIVE_INFINITY,
};
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ENDPOINT = "https://loggers.dev";
// Bump on any behavior change so consumers can tell which SDK they vendored.
// Read at runtime via `Loggers.version`.
const VERSION = "0.1.0";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizeEndpoint(value) {
  const raw =
    typeof value === "string" && value.trim() ? value.trim() : DEFAULT_ENDPOINT;
  return raw.replace(/\/+$/, "");
}

function normalizeLevel(value, fallback = "info") {
  if (!value) return fallback;
  const level = String(value).toLowerCase();
  assert(
    Object.hasOwn(LEVEL_RANK, level),
    "Invalid level; expected debug, info, warn, error, or silent",
  );
  return level;
}

function parseConfiguredLevel(value) {
  if (typeof value !== "string") return null;
  const level = value.trim().toLowerCase();
  if (!level) return null;
  return Object.hasOwn(LEVEL_RANK, level) ? level : null;
}

function envString(env, key) {
  const value = env?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function normalizeData(value) {
  if (value === null || value === undefined) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  return { value };
}

// Serialize a line to its wire/file JSON string. A log call must never throw,
// so unserializable data (circular refs, BigInt, …) is replaced with a marker
// rather than propagating the error to the caller.
function serializeLine(level, component, data, loggedAt) {
  try {
    return JSON.stringify({ level, component, data, logged_at: loggedAt });
  } catch (err) {
    return JSON.stringify({
      level,
      component,
      data: { error: "unserializable log data", detail: String(err) },
      logged_at: loggedAt,
    });
  }
}

function nowMs() {
  return Date.now();
}

// Canonical 26-char ULID, or null if `raw` isn't one.
function coerceUlid(raw) {
  const ulid = String(raw ?? "")
    .trim()
    .toUpperCase();
  return ULID_RE.test(ulid) ? ulid : null;
}

function parseMaybeInt(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.floor(n);
}

function parseYamlScalar(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  if (/^-?\d+$/.test(value)) {
    return Number(value);
  }
  return value;
}

function parseSimpleLoggersYaml(text) {
  const out = {
    timezone: null,
    default_level: null,
    loggers: {},
  };
  let inLoggers = false;
  let currentName = null;

  const lines = String(text ?? "").split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.match(/^ */)[0].length;
    const trimmed = line.trim();

    if (indent === 0) {
      inLoggers = trimmed === "loggers:";
      currentName = null;
      const topMatch = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!topMatch) continue;
      if (topMatch[1] === "timezone") {
        out.timezone = String(parseYamlScalar(topMatch[2]) || "");
      } else if (topMatch[1] === "default_level") {
        out.default_level = String(parseYamlScalar(topMatch[2]) || "");
      }
      continue;
    }
    if (!inLoggers) continue;

    if (indent === 2) {
      const m = trimmed.match(/^([A-Za-z0-9._-]+):\s*(.*)$/);
      if (!m) continue;
      currentName = m[1];
      const inline = m[2];
      if (inline) {
        out.loggers[currentName] = {
          ulid: String(parseYamlScalar(inline) || ""),
        };
        currentName = null;
      } else {
        out.loggers[currentName] = {};
      }
      continue;
    }

    if (indent >= 4 && currentName) {
      const m = trimmed.match(/^([A-Za-z0-9._-]+):\s*(.*)$/);
      if (!m) continue;
      const key = m[1];
      const value = parseYamlScalar(m[2]);
      const row = out.loggers[currentName] || {};
      row[key] = value;
      out.loggers[currentName] = row;
    }
  }
  return out;
}

function readLoggersConfig() {
  const env = process.env || {};
  const cwd = typeof process.cwd === "function" ? process.cwd() : "";
  const home = typeof env.HOME === "string" ? env.HOME.trim() : "";
  const configOverride =
    typeof env.LOGGERS_CONFIG_PATH === "string"
      ? env.LOGGERS_CONFIG_PATH.trim()
      : "";

  const candidates = [
    configOverride || null,
    cwd ? join(cwd, "loggers.yaml") : null,
    home ? join(home, ".config", "loggers", "loggers.yaml") : null,
  ].filter((value, idx, arr) => value && arr.indexOf(value) === idx);

  for (const path of candidates) {
    try {
      const body = readFileSync(path, "utf-8");
      return { path, config: parseSimpleLoggersYaml(body) };
    } catch {
      // keep checking next candidate path
    }
  }
  return { path: null, config: null };
}

// Build a day-key formatter once per timezone (reused for every line); falls
// back to the ISO date if the timezone is unusable.
function makeDayKey(timezone) {
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    fmt = null;
  }
  return (ms) => {
    if (fmt) {
      try {
        return fmt.format(new Date(ms));
      } catch {
        // fall through to ISO
      }
    }
    return new Date(ms).toISOString().slice(0, 10);
  };
}

class LoggerHandle {
  constructor(options) {
    assert(
      options && typeof options === "object",
      "Loggers.create(...) requires options",
    );
    const name = String(options.name ?? "").trim() || null;
    const ulidRaw = String(options.ulid ?? "").trim();
    assert(name || ulidRaw, "Either name or ulid is required");

    const component = String(options.component ?? "app").trim();
    assert(component.length > 0, "component is required");

    this.endpoint = normalizeEndpoint(options.endpoint);
    this.name = name;
    this.component = component;
    this.ulid = null;
    this.queue = []; // remote-pending lines
    this.localQueue = []; // { line, dir } pending local-file writes
    this.closed = false;
    this.inFlight = null;

    // ── Resolve the ULID synchronously: option, then env, then config. ──
    const warnings = [];
    if (ulidRaw) {
      this.ulid = coerceUlid(ulidRaw);
      if (!this.ulid) {
        warnings.push({
          msg: "invalid ULID in Loggers.create({ ulid })",
          provided_ulid: ulidRaw,
        });
      }
    }

    const { config } = readLoggersConfig();
    const env = process.env || {};
    const envName = envString(env, "LOGGERS_NAME");
    const envUlid = envString(env, "LOGGERS_ULID");
    const envLevel = parseConfiguredLevel(envString(env, "LOGGERS_LEVEL"));
    const loggerRow =
      name && config?.loggers ? config.loggers[name] || null : null;

    if (!this.ulid && name && envName && envName === name) {
      this.ulid = coerceUlid(envUlid);
      if (!this.ulid) {
        warnings.push({
          msg: "LOGGERS_NAME matched but LOGGERS_ULID was missing/invalid",
          name,
          provided_ulid: envUlid || null,
        });
      }
    }

    if (!this.ulid && loggerRow) {
      const fromConfig =
        typeof loggerRow === "string"
          ? loggerRow
          : typeof loggerRow.ulid === "string"
            ? loggerRow.ulid
            : "";
      this.ulid = coerceUlid(fromConfig);
      if (!this.ulid && fromConfig) {
        warnings.push({
          msg: "invalid ULID for name in loggers.yaml",
          name,
          provided_ulid: String(fromConfig),
        });
      }
    }

    if (!this.ulid && name) {
      warnings.push({
        msg: "name did not resolve to a valid ULID; remote disabled",
        name,
      });
    }
    this.remoteEnabled = Boolean(this.ulid);

    // ── Level: option > env > config (per-logger then default) > "info". ──
    const levelFromConfig = parseConfiguredLevel(
      name && loggerRow && typeof loggerRow.level === "string"
        ? loggerRow.level
        : typeof config?.default_level === "string"
          ? config.default_level
          : null,
    );
    this.minLevel =
      options.level !== undefined
        ? normalizeLevel(options.level, "info")
        : (envLevel ?? levelFromConfig ?? "info");

    // ── Local sink. ──
    const localOption =
      options.local && typeof options.local === "object" ? options.local : {};
    const explicitLocalRequested =
      options.local === true ||
      (options.local &&
        typeof options.local === "object" &&
        options.local.enabled !== false);
    const explicitRetention = parseMaybeInt(
      options.fileRetentionDays ?? localOption.retentionDays,
    );
    const configRetention = parseMaybeInt(loggerRow?.file_retention_days);
    let retentionDays =
      explicitRetention ?? configRetention ?? (explicitLocalRequested ? 7 : 0);
    if (retentionDays < 0) retentionDays = 0;

    const localEnabled =
      retentionDays > 0 && (explicitLocalRequested || configRetention !== null);
    const localTimezone =
      String(localOption.timezone ?? config?.timezone ?? "UTC").trim() || "UTC";
    let localDir = String(localOption.dir ?? "").trim();
    if (!localDir && typeof process.cwd === "function") {
      localDir = join(process.cwd(), "loggers");
    }
    if (!localDir) localDir = "loggers";

    this.localState = {
      enabled: localEnabled,
      dir: localDir,
      name: name || this.ulid || "logger",
      timezone: localTimezone,
      toDay: makeDayKey(localTimezone),
      retentionDays,
      lastCleanupDay: null,
    };

    const flushIntervalMs = Number(options.flushIntervalMs ?? 20_000);
    this.flushIntervalMs = Number.isFinite(flushIntervalMs)
      ? Math.max(10_000, Math.floor(flushIntervalMs))
      : 20_000;
    const batchSize = Number(options.batchSize ?? 500);
    this.batchSize =
      Number.isFinite(batchSize) && batchSize > 0 ? Math.floor(batchSize) : 500;

    this.timer = setInterval(() => {
      this.flush().catch(() => {
        // Keep lines queued; caller can inspect flush()/close() rejections.
      });
    }, this.flushIntervalMs);
    // Don't let the flush timer alone keep the process alive (Node/Bun; Deno's
    // numeric timer id has no unref, so this is a no-op there).
    if (typeof this.timer?.unref === "function") this.timer.unref();

    // Emit config diagnostics to the local file regardless of sink state.
    for (const warning of warnings) this.queueDiagnostic(warning);
  }

  isEnabled(level) {
    return LEVEL_RANK[level] >= LEVEL_RANK[this.minLevel];
  }

  setLevel(level) {
    this.minLevel = normalizeLevel(level, this.minLevel);
    return this;
  }

  setDir(dir) {
    const next = String(dir ?? "").trim();
    if (next) {
      // Only affects future lines: already-queued lines carry the dir they
      // were logged against, so a retarget never mis-routes buffered writes.
      this.localState.dir = next;
      // Retention is tracked per-directory; re-check after a retarget.
      this.localState.lastCleanupDay = null;
    }
    return this;
  }

  // A lightweight logger that tags lines with `component` by default. It shares
  // this handle's queue, batching, level, and local sink — it is not a new
  // handle (no extra timer or config resolution).
  child(component) {
    return new LoggerChild(this, component);
  }

  enqueue(level, data, componentOverride) {
    assert(!this.closed, "Logger is closed");
    assert(
      Object.hasOwn(LEVEL_RANK, level),
      "Invalid level; expected debug, info, warn, or error",
    );
    if (!this.isEnabled(level)) return;

    const component =
      componentOverride === undefined
        ? this.component
        : String(componentOverride).trim();
    assert(component.length > 0, "component is required");

    const loggedAt = nowMs();
    // Serialize once, here: this snapshots the data (later mutation of the
    // caller's object can't change what was logged) and avoids re-stringifying
    // for each sink. Both queues hold the finished JSON string.
    const json = serializeLine(level, component, normalizeData(data), loggedAt);

    if (this.remoteEnabled) {
      this.queue.push(json);
      if (this.queue.length >= this.batchSize) {
        this.flush().catch(() => {
          // Keep lines queued for a later flush attempt.
        });
      }
    }
    if (this.localState.enabled) {
      // Snapshot the target dir and day now so a later setDir() (or a day
      // boundary before flush) can't re-route or re-bucket this line.
      this.localQueue.push({
        json,
        dir: this.localState.dir,
        day: this.localState.toDay(loggedAt),
      });
      if (this.localQueue.length >= this.batchSize) {
        this.flush().catch(() => {});
      }
    }
  }

  // Append all buffered local lines, grouped by (dir, UTC day) into one write
  // per file. Failures are swallowed — local logging must not crash ingestion.
  async writeLocalBatch() {
    if (this.localQueue.length === 0) return;
    const entries = this.localQueue.splice(0, this.localQueue.length);
    const state = this.localState;

    const groups = new Map();
    for (const { json, dir, day } of entries) {
      const key = `${dir} ${day}`;
      let group = groups.get(key);
      if (!group) {
        group = { dir, day, lines: [] };
        groups.set(key, group);
      }
      group.lines.push(json);
    }

    for (const { dir, day, lines } of groups.values()) {
      try {
        const baseDir = join(dir, state.name);
        const filePath = join(baseDir, `${day}.log`);
        await mkdir(baseDir, { recursive: true });
        const body = `${lines.join("\n")}\n`;
        await appendFile(filePath, body, "utf-8");
        await this.pruneRetention(baseDir, day);
      } catch {
        // Drop this group on write failure (do not retry — avoids an
        // unbounded queue when a directory is permanently unwritable).
      }
    }
  }

  async pruneRetention(baseDir, day) {
    const state = this.localState;
    if (state.retentionDays <= 0 || state.lastCleanupDay === day) return;
    state.lastCleanupDay = day;
    const cutoff = Date.now() - state.retentionDays * DAY_MS;
    const files = await readdir(baseDir);
    for (const file of files) {
      const m = file.match(/^(\d{4}-\d{2}-\d{2})\.log$/);
      if (!m) continue;
      const ts = Date.parse(`${m[1]}T00:00:00.000Z`);
      if (!Number.isFinite(ts) || ts >= cutoff) continue;
      await unlink(join(baseDir, file)).catch(() => {});
    }
  }

  // Diagnostics about a degraded config are always written locally, even when
  // the normal local sink is disabled.
  queueDiagnostic(extraData) {
    const loggedAt = nowMs();
    const json = serializeLine(
      "warn",
      "loggers.js",
      { msg: "logger configured for local-only fallback", ...extraData },
      loggedAt,
    );
    this.localQueue.push({
      json,
      dir: this.localState.dir,
      day: this.localState.toDay(loggedAt),
    });
  }

  debug(data, componentOverride) {
    this.enqueue("debug", data, componentOverride);
  }

  info(data, componentOverride) {
    this.enqueue("info", data, componentOverride);
  }

  warn(data, componentOverride) {
    this.enqueue("warn", data, componentOverride);
  }

  error(data, componentOverride) {
    this.enqueue("error", data, componentOverride);
  }

  async flush() {
    // Drain pending local writes first so files are current on return.
    await this.writeLocalBatch();

    if (!this.remoteEnabled) {
      this.queue.length = 0;
      return;
    }
    if (this.inFlight) return this.inFlight;
    if (this.queue.length === 0) return;

    this.inFlight = (async () => {
      try {
        while (this.queue.length > 0) {
          const lines = this.queue.splice(0, this.batchSize);
          try {
            await this.postBatch(lines);
          } catch (err) {
            this.queue.unshift(...lines);
            throw err;
          }
        }
      } finally {
        this.inFlight = null;
      }
    })();

    return this.inFlight;
  }

  async postBatch(lines) {
    assert(this.ulid, "Remote ingest is disabled: no ULID resolved");
    const f = globalThis.fetch;
    assert(typeof f === "function", "global fetch is unavailable");
    // `lines` are already-serialized JSON strings; assemble the array body
    // without re-stringifying each entry.
    const res = await f(`${this.endpoint}/logger/${this.ulid}/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: `{"lines":[${lines.join(",")}]}`,
    });
    if (!res.ok) {
      let body = "";
      try {
        body = await res.text();
      } catch {
        // ignore read failures
      }
      throw new Error(
        `Loggers ingest failed (${res.status}): ${body || res.statusText}`,
      );
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    await this.flush();
  }
}

// Bound view over a LoggerHandle with a default component. All logging routes
// through the root handle, so the queue, batching, level, and local sink are
// shared; lifecycle methods delegate to the root.
class LoggerChild {
  constructor(root, component) {
    const c = String(component ?? "").trim();
    assert(c.length > 0, "component is required");
    this.root = root;
    this.component = c;
  }

  child(component) {
    return new LoggerChild(this.root, component);
  }

  debug(data, component) {
    this.root.enqueue("debug", data, component ?? this.component);
  }

  info(data, component) {
    this.root.enqueue("info", data, component ?? this.component);
  }

  warn(data, component) {
    this.root.enqueue("warn", data, component ?? this.component);
  }

  error(data, component) {
    this.root.enqueue("error", data, component ?? this.component);
  }

  setLevel(level) {
    this.root.setLevel(level);
    return this;
  }

  setDir(dir) {
    this.root.setDir(dir);
    return this;
  }

  flush() {
    return this.root.flush();
  }

  close() {
    return this.root.close();
  }
}

export const Loggers = {
  version: VERSION,
  create(options) {
    return new LoggerHandle(options ?? {});
  },
};
