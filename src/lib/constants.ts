import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";

// Paths
export const ROOT_DIR = resolve(import.meta.dir, "../..");
export const DATA_DIR = resolve(ROOT_DIR, "data");
export const LOG_DIR = resolve(ROOT_DIR, "log");
export const CONFIG_DIR = resolve(ROOT_DIR, "config");
export const VIEWS_DIR = resolve(ROOT_DIR, "views");
export const PUBLIC_DIR = resolve(ROOT_DIR, "public");

/** Content-Type for raw markdown and plain-text HTTP responses. */
export const CONTENT_TYPE_MARKDOWN_UTF8 = "text/markdown; charset=utf-8";
export const CONTENT_TYPE_TEXT_UTF8 = "text/plain; charset=utf-8";

// Global user config
export const USER_CONFIG_DIR = resolve(
  process.env.HOME || "~",
  ".config/wikis",
);

// Server config from config/wikis.yml
const configPath = resolve(CONFIG_DIR, "wikis.yml");

function loadConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed = yaml.load(readFileSync(path, "utf8"));
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Invalid config in ${path}: expected a mapping at the top level`,
    );
  }
  return parsed as Record<string, unknown>;
}

const rawConfig = loadConfig(configPath);

export const PORT = Number(process.env.PORT || rawConfig.port || 3000);
export const HOST = String(process.env.HOST || rawConfig.host || "0.0.0.0");

// Legendum (hosted mode)
export const LEGENDUM_API_KEY =
  process.env.LEGENDUM_API_KEY || (rawConfig.legendum_api_key as string);
export const LEGENDUM_SECRET =
  process.env.LEGENDUM_SECRET || (rawConfig.legendum_secret as string);
export const LEGENDUM_BASE_URL =
  process.env.LEGENDUM_BASE_URL ||
  (rawConfig.legendum_base_url as string) ||
  "https://legendum.co.uk";

export const IS_HOSTED = Boolean(LEGENDUM_API_KEY && LEGENDUM_SECRET);

// LLM (self-hosted mode — first configured provider wins)
export const CLAUDE_API_KEY =
  process.env.CLAUDE_API_KEY || (rawConfig.anthropic_api_key as string);
export const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || (rawConfig.openai_api_key as string);
export const XAI_API_KEY =
  process.env.XAI_API_KEY || (rawConfig.xai_api_key as string);
export const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY || (rawConfig.gemini_api_key as string);

// Ollama (embeddings)
export const OLLAMA_URL =
  process.env.OLLAMA_URL ||
  (rawConfig.ollama_url as string) ||
  "http://localhost:11434";
export const OLLAMA_EMBED_MODEL =
  process.env.OLLAMA_EMBED_MODEL ||
  (rawConfig.ollama_embed_model as string) ||
  "all-minilm";

// Content previews
export const PAGE_PREVIEW_LENGTH = 2048;

// Search tuning
export const SEARCH_CHUNK_SIZE = Number(rawConfig.search_chunk_size || 512);
export const SEARCH_CHUNK_OVERLAP = Number(
  rawConfig.search_chunk_overlap || 64,
);
export const SEARCH_FTS_WEIGHT = Number(rawConfig.search_fts_weight || 0.7);
export const SEARCH_VECTOR_WEIGHT = Number(
  rawConfig.search_vector_weight || 0.3,
);
export const SEARCH_DEFAULT_LIMIT = Number(
  rawConfig.search_default_limit || 20,
);

// Source watching
export const SOURCE_CHECK_MIN_INTERVAL = Number(
  rawConfig.source_check_min_interval || 300,
);
export const SOURCE_CHECK_MAX_INTERVAL = Number(
  rawConfig.source_check_max_interval || 1800,
);

// Billing — pricing is in config/pricing.yml, Legendum integration in lib/billing.ts

// Logging
export const LOG_LEVEL =
  process.env.LOG_LEVEL || (rawConfig.log_level as string) || "info";
