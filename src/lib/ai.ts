/**
 * Unified AI provider abstraction.
 * Adapted from chats2me — non-streaming only (server-side agent).
 */

export type Provider = "xai" | "openai" | "google" | "anthropic";

export interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_call_id?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatOptions {
  provider?: Provider | string;
  messages: ChatMessage[];
  model?: string;
  tools?: ToolDefinition[];
}

export interface ChatResult {
  content: string;
  usage: { input_tokens: number; output_tokens: number };
  tool_calls?: ToolCall[];
}

const ALIASES: Record<string, Provider> = {
  grok: "xai",
  gpt: "openai",
  gemini: "google",
  claude: "anthropic",
};

const DEFAULT_MODELS: Record<Provider, string> = {
  xai: "grok-4-1-fast-reasoning",
  openai: "gpt-5-mini",
  google: "gemini-3.1-flash-lite-preview",
  anthropic: "claude-haiku-4-5",
};

export function resolveProvider(input?: string): Provider {
  if (!input) return detectProvider();
  const lower = input.toLowerCase();
  return ALIASES[lower] || (lower as Provider);
}

/** Detect provider from available env vars. */
function detectProvider(): Provider {
  if (process.env.XAI_API_KEY) return "xai";
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.GEMINI_API_KEY) return "google";
  if (process.env.CLAUDE_API_KEY) return "anthropic";
  throw new Error(
    "No LLM API key configured (XAI_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or CLAUDE_API_KEY)",
  );
}

export function defaultModel(provider: Provider): string {
  return DEFAULT_MODELS[provider];
}

/**
 * Unified chat function. Routes to the correct provider.
 */
export async function chat(options: ChatOptions): Promise<ChatResult> {
  const provider = resolveProvider(options.provider);
  const model = options.model || defaultModel(provider);
  const opts = { ...options, provider, model };

  switch (provider) {
    case "xai": {
      const { chatGrok } = await import("./providers/grok");
      return chatGrok(opts);
    }
    case "openai": {
      const { chatOpenAI } = await import("./providers/openai");
      return chatOpenAI(opts);
    }
    default:
      throw new Error(`Provider ${provider} not yet implemented — PRs welcome`);
  }
}
