/** Chat-with-billing wrapper used by all agent LLM calls. */
import type { Database } from "bun:sqlite";
import { type ChatMessage, type ChatResult, chat } from "../ai";
import {
  type Reservation,
  release,
  reserve,
  settle,
  shouldBill,
} from "../billing";
import type { WikiConfig } from "./types";

const RESERVE_CREDITS = 50;

export type ChatFn = (opts: {
  messages: ChatMessage[];
  description?: string;
}) => Promise<ChatResult>;

/**
 * Chat with billing: reserve → call LLM → settle.
 * Only bills when config has a legendumToken and user doesn't have their own key.
 */
export async function billedChat(
  db: Database,
  wikiId: number,
  config: WikiConfig,
  options: { messages: ChatMessage[]; description?: string },
): Promise<ChatResult> {
  const projectTitle =
    config.name.charAt(0).toUpperCase() + config.name.slice(1);
  const description = options.description || `Wiki ${projectTitle}`;
  const bill = config.legendumToken && shouldBill(!!config.userHasOwnKey);
  let reservation: Reservation | null = null;

  if (bill && config.legendumToken) {
    reservation = await reserve(
      config.legendumToken,
      RESERVE_CREDITS,
      description,
    );
  }

  try {
    const result = await chat(options);

    await settle(
      reservation,
      config.legendumToken,
      result.usage.input_tokens,
      result.usage.output_tokens,
      description,
      { db, wikiId },
    );

    return result;
  } catch (e) {
    await release(reservation);
    throw e;
  }
}
