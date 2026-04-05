/**
 * xAI (Grok) provider — OpenAI-compatible SDK with custom base URL.
 */
import OpenAI from "openai";
import type { ChatOptions, ChatResult } from "../ai";
import { chatOpenAICompat } from "./openai-compat";

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) throw new Error("XAI_API_KEY not configured");
    client = new OpenAI({ apiKey, baseURL: "https://api.x.ai/v1" });
  }
  return client;
}

export async function chatGrok(
  options: ChatOptions & { model: string }
): Promise<ChatResult> {
  return chatOpenAICompat(getClient(), options);
}
