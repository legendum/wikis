/**
 * OpenAI provider.
 */
import OpenAI from "openai";
import type { ChatOptions, ChatResult } from "../ai";
import { chatOpenAICompat } from "./openai-compat";

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY not configured");
    client = new OpenAI({ apiKey });
  }
  return client;
}

export async function chatOpenAI(
  options: ChatOptions & { model: string },
): Promise<ChatResult> {
  return chatOpenAICompat(getClient(), options);
}
