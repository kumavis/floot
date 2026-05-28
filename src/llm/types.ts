export type LLMProviderKind = "anthropic" | "ollama" | "claude-cli";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

export interface ChatMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export type LLMStreamEvent =
  | { type: "text_start" }
  | { type: "text_delta"; text: string }
  | { type: "text_end" }
  | { type: "tool_call"; id: string; name: string; input: Record<string, unknown> }
  | { type: "turn_end"; stopReason: "end_turn" | "tool_use" }
  | { type: "provider_session"; sessionId: string };

export interface LLMStreamTurnOptions {
  system: string;
  messages: ChatMessage[];
  latestUserMessage: string;
  providerSessionId?: string;
  signal?: AbortSignal;
}

export interface ModelSummary {
  id: string;
  label: string;
  provider: LLMProviderKind;
}

export interface AnthropicModelConfig {
  id: string;
  label: string;
  provider: "anthropic";
  model: string;
  host: string;
  auth_token: string;
  max_tokens?: number;
  system_prompt?: string;
}

export interface OllamaModelConfig {
  id: string;
  label: string;
  provider: "ollama";
  model: string;
  host: string;
  options?: Record<string, unknown>;
  system_prompt?: string;
}

export interface ClaudeCliModelConfig {
  id: string;
  label: string;
  provider: "claude-cli";
  model: string;
  binary?: string;
  max_turns?: number;
  permission_mode?: string;
  system_prompt?: string;
}

export type ModelConfig =
  | AnthropicModelConfig
  | OllamaModelConfig
  | ClaudeCliModelConfig;

export interface LLMProvider {
  readonly kind: LLMProviderKind;
  readonly supportsFlootTools: boolean;
  streamTurn(options: LLMStreamTurnOptions): AsyncGenerator<LLMStreamEvent>;
}
