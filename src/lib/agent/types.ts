/** Shared types and constants for the wiki agent. */

export const SPECIAL_PAGES = new Set(["index.md", "log.md"]);

export interface WikiConfig {
  name: string;
  sections?: { name: string; description: string }[];
  /** Legendum token for billing. Null = no billing (self-hosted or own API key). */
  legendumToken?: string | null;
  /** Whether user provides their own LLM API key (no billing). */
  userHasOwnKey?: boolean;
}

export interface AgentResult {
  pagesUpdated: string[];
  pagesCreated: string[];
  usage: { input_tokens: number; output_tokens: number };
}
