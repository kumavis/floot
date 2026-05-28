import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { parse as parseYaml } from "yaml";
import type {
  LLMProviderKind,
  ModelConfig,
  ModelSummary,
} from "../llm/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

const ENV_REF_PATTERN = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

interface RawModelsFile {
  default_model?: string;
  system_prompt?: string;
  models?: Record<string, Record<string, unknown>>;
}

function interpolateEnv(value: string, context: string): string {
  return value.replace(ENV_REF_PATTERN, (_match, name: string) => {
    const envValue = process.env[name];
    if (envValue === undefined || envValue === "") {
      throw new Error(
        `Missing environment variable ${name} required by models config (${context})`
      );
    }
    return envValue;
  });
}

function interpolateValue(value: unknown, context: string): unknown {
  if (typeof value === "string") {
    return interpolateEnv(value, context);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      interpolateValue(item, `${context}[${index}]`)
    );
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      result[key] = interpolateValue(nested, `${context}.${key}`);
    }
    return result;
  }
  return value;
}

function readString(
  raw: Record<string, unknown>,
  key: string,
  required = true
): string | undefined {
  const value = raw[key];
  if (value === undefined || value === null) {
    if (required) {
      throw new Error(`models.yml: missing required field "${key}"`);
    }
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`models.yml: "${key}" must be a non-empty string`);
  }
  return value;
}

function parseModelConfig(id: string, raw: Record<string, unknown>): ModelConfig {
  const label = readString(raw, "label") ?? id;
  const provider = readString(raw, "provider") as LLMProviderKind | undefined;
  const model = readString(raw, "model");

  if (!provider) {
    throw new Error(`models.yml: model "${id}" is missing provider`);
  }
  if (!model) {
    throw new Error(`models.yml: model "${id}" is missing model`);
  }

  const systemPrompt =
    typeof raw.system_prompt === "string" ? raw.system_prompt : undefined;

  switch (provider) {
    case "anthropic": {
      const host = readString(raw, "host");
      const authToken = readString(raw, "auth_token");
      if (!host || !authToken) {
        throw new Error(
          `models.yml: anthropic model "${id}" requires host and auth_token`
        );
      }
      return {
        id,
        label,
        provider,
        model,
        host,
        auth_token: authToken,
        max_tokens:
          typeof raw.max_tokens === "number" ? raw.max_tokens : undefined,
        system_prompt: systemPrompt,
      };
    }
    case "ollama": {
      const host = readString(raw, "host") ?? "http://localhost:11434";
      return {
        id,
        label,
        provider,
        model,
        host,
        options:
          raw.options && typeof raw.options === "object"
            ? (raw.options as Record<string, unknown>)
            : undefined,
        system_prompt: systemPrompt,
      };
    }
    case "claude-cli":
      return {
        id,
        label,
        provider,
        model,
        binary:
          typeof raw.binary === "string" && raw.binary.trim()
            ? raw.binary
            : undefined,
        max_turns:
          typeof raw.max_turns === "number" ? raw.max_turns : undefined,
        permission_mode:
          typeof raw.permission_mode === "string"
            ? raw.permission_mode
            : undefined,
        system_prompt: systemPrompt,
      };
    default:
      throw new Error(
        `models.yml: model "${id}" has unsupported provider "${provider}"`
      );
  }
}

export class ModelsConfig {
  private readonly models = new Map<string, ModelConfig>();
  private readonly catalog: ModelConfig[];

  private constructor(
    private readonly globalSystemPrompt: string,
    entries: ModelConfig[]
  ) {
    this.catalog = entries;
    for (const entry of entries) {
      this.models.set(entry.id, entry);
    }
  }

  static async load(configPath?: string): Promise<ModelsConfig> {
    const resolvedPath =
      configPath ??
      process.env.FLOOT_CONFIG ??
      path.join(PROJECT_ROOT, "models.yml");

    let rawText: string;
    try {
      rawText = await readFile(resolvedPath, "utf-8");
    } catch (err) {
      const fallback = path.join(PROJECT_ROOT, "models.yml.example");
      try {
        rawText = await readFile(fallback, "utf-8");
        console.warn(
          `[config] ${resolvedPath} not found; using ${fallback}. Copy it to models.yml to customize.`
        );
      } catch {
        throw new Error(
          `Failed to load models config from ${resolvedPath}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    const parsed = parseYaml(rawText) as RawModelsFile;
    if (!parsed || typeof parsed !== "object") {
      throw new Error("models.yml must be a YAML object");
    }

    const interpolated = interpolateValue(parsed, "models.yml") as RawModelsFile;

    const rawModels = interpolated.models;
    if (!rawModels || typeof rawModels !== "object") {
      throw new Error("models.yml: models map is required");
    }

    const entries: ModelConfig[] = [];
    for (const [id, raw] of Object.entries(rawModels)) {
      if (!raw || typeof raw !== "object") {
        throw new Error(`models.yml: model "${id}" must be an object`);
      }
      entries.push(parseModelConfig(id, raw));
    }

    if (entries.length === 0) {
      throw new Error("models.yml: at least one model is required");
    }

    const config = new ModelsConfig(
      typeof interpolated.system_prompt === "string"
        ? interpolated.system_prompt
        : "",
      entries
    );

    return config;
  }

  hasModel(id: string): boolean {
    return this.models.has(id);
  }

  getDefaultModelId(): string {
    return this.catalog[0]?.id ?? "";
  }

  getModelLabel(id: string): string {
    return this.models.get(id)?.label ?? id;
  }

  getModelsCatalog(): ModelSummary[] {
    return this.catalog.map((model) => ({
      id: model.id,
      label: model.label,
      provider: model.provider,
    }));
  }

  getModelConfig(id: string): ModelConfig {
    const config = this.models.get(id);
    if (!config) {
      throw new Error(`Unknown model: ${id}`);
    }
    return config;
  }

  getSystemPrompt(modelId?: string): string {
    if (modelId) {
      const model = this.models.get(modelId);
      if (model?.system_prompt) {
        return model.system_prompt;
      }
    }
    return this.globalSystemPrompt;
  }
}
