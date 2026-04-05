/**
 * Shared OpenAI-compatible chat implementation.
 * Used by both OpenAI and xAI (Grok) providers.
 * Non-streaming only — this runs server-side for wiki maintenance.
 */
import type OpenAI from 'openai';
import type {
  ChatMessage,
  ChatOptions,
  ChatResult,
  ToolDefinition,
} from '../ai';

function toOpenAITools(tools: ToolDefinition[]): OpenAI.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

function toOpenAIMessages(
  messages: ChatMessage[]
): OpenAI.ChatCompletionMessageParam[] {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return {
        role: 'tool' as const,
        content: m.content,
        tool_call_id: m.tool_call_id || '',
      };
    }
    return {
      role: m.role as 'user' | 'assistant' | 'system',
      content: m.content,
    };
  });
}

export async function chatOpenAICompat(
  client: OpenAI,
  options: ChatOptions & { model: string }
): Promise<ChatResult> {
  const params: OpenAI.ChatCompletionCreateParams = {
    model: options.model,
    messages: toOpenAIMessages(options.messages),
    stream: false,
  };

  if (options.tools?.length) {
    params.tools = toOpenAITools(options.tools);
  }

  const completion = await client.chat.completions.create(params);
  const message = completion.choices[0]?.message;
  const usage = completion.usage;

  const result: ChatResult = {
    content: message?.content || '',
    usage: {
      input_tokens: usage?.prompt_tokens ?? 0,
      output_tokens: usage?.completion_tokens ?? 0,
    },
  };

  if (message?.tool_calls?.length) {
    result.tool_calls = message.tool_calls.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments || '{}'),
    }));
  }

  return result;
}
