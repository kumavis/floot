import type { ModelConfig, LLMProvider } from "./types.js";
import { AnthropicProvider } from "./anthropic.js";
import { OllamaProvider } from "./ollama.js";
import { ClaudeCliProvider } from "./claude-cli.js";

export * from "./types.js";
export { FLOOT_TOOLS, OLLAMA_TOOLS } from "./tools.js";

export function createLLMProvider(
  config: ModelConfig,
  projectRoot: string
): LLMProvider {
  switch (config.provider) {
    case "anthropic":
      return new AnthropicProvider(config);
    case "ollama":
      return new OllamaProvider(config);
    case "claude-cli":
      return new ClaudeCliProvider(config, projectRoot);
  }
}
