import Anthropic from "@anthropic-ai/sdk";
import type {
  AnthropicModelConfig,
  ChatMessage,
  ContentBlock,
  LLMProvider,
  LLMStreamEvent,
  LLMStreamTurnOptions,
} from "./types.js";
import { FLOOT_TOOLS } from "./tools.js";

function toAnthropicMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  return messages.map((message) => {
    if (typeof message.content === "string") {
      return { role: message.role, content: message.content };
    }

    const blocks: Anthropic.ContentBlockParam[] = message.content.map((block) => {
      switch (block.type) {
        case "text":
          return { type: "text", text: block.text };
        case "tool_use":
          return {
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: block.input,
          };
        case "tool_result":
          return {
            type: "tool_result",
            tool_use_id: block.tool_use_id,
            content: block.content,
          };
      }
    });

    return { role: message.role, content: blocks };
  });
}

function toContentBlocks(content: Anthropic.ContentBlock[]): ContentBlock[] {
  return content.flatMap((block): ContentBlock[] => {
    if (block.type === "text") {
      return [{ type: "text", text: block.text }];
    }
    if (block.type === "tool_use") {
      return [
        {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        },
      ];
    }
    return [];
  });
}

export class AnthropicProvider implements LLMProvider {
  readonly kind = "anthropic" as const;
  readonly supportsFlootTools = true;

  constructor(private readonly config: AnthropicModelConfig) {}

  async *streamTurn(
    options: LLMStreamTurnOptions
  ): AsyncGenerator<LLMStreamEvent> {
    const client = new Anthropic({
      apiKey: this.config.auth_token,
      baseURL: this.config.host,
    });

    const stream = client.messages.stream(
      {
        model: this.config.model,
        max_tokens: this.config.max_tokens ?? 64000,
        system: options.system,
        tools: FLOOT_TOOLS,
        messages: toAnthropicMessages(options.messages),
      },
      { signal: options.signal }
    );

    for await (const event of stream) {
      switch (event.type) {
        case "content_block_start":
          if (event.content_block.type === "text") {
            yield { type: "text_start" };
          }
          break;
        case "content_block_delta":
          if (event.delta.type === "text_delta") {
            yield { type: "text_delta", text: event.delta.text };
          }
          break;
        case "content_block_stop": {
          const finalMsg = await stream.finalMessage();
          const block = finalMsg.content[event.index];
          if (block.type === "text") {
            yield { type: "text_end" };
          } else if (block.type === "tool_use") {
            yield {
              type: "tool_call",
              id: block.id,
              name: block.name,
              input: block.input as Record<string, unknown>,
            };
          }
          break;
        }
      }
    }

    const finalMessage = await stream.finalMessage();
    const rawStop = finalMessage.stop_reason;
    if (rawStop === "tool_use") {
      yield { type: "turn_end", stopReason: "tool_use" };
    } else if (rawStop === "end_turn" || rawStop === null || rawStop === undefined) {
      yield { type: "turn_end", stopReason: "end_turn" };
    } else {
      yield { type: "turn_end", stopReason: "stop", reason: rawStop };
    }
  }
}

export function blocksFromAnthropicMessage(
  content: Anthropic.ContentBlock[]
): ContentBlock[] {
  return toContentBlocks(content);
}
