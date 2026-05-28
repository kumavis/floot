import type {
  ChatMessage,
  ContentBlock,
  LLMProvider,
  LLMStreamEvent,
  LLMStreamTurnOptions,
  OllamaModelConfig,
} from "./types.js";
import { OLLAMA_TOOLS } from "./tools.js";

interface OllamaChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{
    id?: string;
    function: { name: string; arguments: Record<string, unknown> | string };
  }>;
  tool_name?: string;
}

interface OllamaStreamChunk {
  message?: {
    role?: string;
    content?: string;
    tool_calls?: Array<{
      id?: string;
      function?: { name?: string; arguments?: Record<string, unknown> | string };
    }>;
  };
  done?: boolean;
}

function findToolName(messages: ChatMessage[], toolUseId: string): string | undefined {
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const block of message.content) {
      if (block.type === "tool_use" && block.id === toolUseId) {
        return block.name;
      }
    }
  }
  return undefined;
}

function toOllamaMessages(
  system: string,
  messages: ChatMessage[]
): OllamaChatMessage[] {
  const result: OllamaChatMessage[] = [{ role: "system", content: system }];

  for (const message of messages) {
    if (typeof message.content === "string") {
      result.push({ role: message.role, content: message.content });
      continue;
    }

    if (message.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: OllamaChatMessage["tool_calls"] = [];

      for (const block of message.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            function: { name: block.name, arguments: block.input },
          });
        }
      }

      result.push({
        role: "assistant",
        content: textParts.join(""),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    for (const block of message.content) {
      if (block.type === "tool_result") {
        result.push({
          role: "tool",
          content: block.content,
          tool_name:
            findToolName(messages, block.tool_use_id) ?? block.tool_use_id,
        });
      } else if (block.type === "text") {
        result.push({ role: "user", content: block.text });
      }
    }
  }

  return result;
}

function parseToolArguments(
  args: Record<string, unknown> | string | undefined
): Record<string, unknown> {
  if (!args) return {};
  if (typeof args === "object") return args;
  try {
    return JSON.parse(args) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export class OllamaProvider implements LLMProvider {
  readonly kind = "ollama" as const;
  readonly supportsFlootTools = true;

  constructor(private readonly config: OllamaModelConfig) {}

  async *streamTurn(
    options: LLMStreamTurnOptions
  ): AsyncGenerator<LLMStreamEvent> {
    const url = `${this.config.host.replace(/\/$/, "")}/api/chat`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.config.model,
        messages: toOllamaMessages(options.system, options.messages),
        tools: OLLAMA_TOOLS,
        stream: true,
        options: this.config.options,
      }),
      signal: options.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Ollama request failed (${response.status}): ${body}`);
    }
    if (!response.body) {
      throw new Error("Ollama response had no body");
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let textStarted = false;
    const toolCalls = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();

    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        const parsed = JSON.parse(line) as OllamaStreamChunk;
        const message = parsed.message;
        if (!message) continue;

        if (message.content) {
          if (!textStarted) {
            textStarted = true;
            yield { type: "text_start" };
          }
          yield { type: "text_delta", text: message.content };
        }

        if (message.tool_calls) {
          for (let index = 0; index < message.tool_calls.length; index++) {
            const call = message.tool_calls[index];
            const fn = call.function;
            if (!fn?.name) continue;

            const existing = toolCalls.get(index) ?? {
              id: call.id ?? `tool_${index}`,
              name: fn.name,
              arguments: "",
            };
            if (call.id) existing.id = call.id;
            if (fn.name) existing.name = fn.name;
            if (fn.arguments !== undefined) {
              existing.arguments +=
                typeof fn.arguments === "string"
                  ? fn.arguments
                  : JSON.stringify(fn.arguments);
            }
            toolCalls.set(index, existing);
          }
        }

        if (parsed.done) {
          if (textStarted) {
            yield { type: "text_end" };
          }

          for (const call of toolCalls.values()) {
            yield {
              type: "tool_call",
              id: call.id,
              name: call.name,
              input: parseToolArguments(call.arguments),
            };
          }

          yield {
            type: "turn_end",
            stopReason: toolCalls.size > 0 ? "tool_use" : "end_turn",
          };
          return;
        }
      }
    }

    if (textStarted) {
      yield { type: "text_end" };
    }
    for (const call of toolCalls.values()) {
      yield {
        type: "tool_call",
        id: call.id,
        name: call.name,
        input: parseToolArguments(call.arguments),
      };
    }
    yield {
      type: "turn_end",
      stopReason: toolCalls.size > 0 ? "tool_use" : "end_turn",
    };
  }
}

export function blocksFromOllamaTurn(params: {
  text: string;
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
}): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (params.text) {
    blocks.push({ type: "text", text: params.text });
  }
  for (const call of params.toolCalls) {
    blocks.push({
      type: "tool_use",
      id: call.id,
      name: call.name,
      input: call.input,
    });
  }
  return blocks;
}
