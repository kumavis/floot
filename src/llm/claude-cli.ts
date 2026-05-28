import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { createInterface } from "readline";
import type {
  ClaudeCliModelConfig,
  LLMProvider,
  LLMStreamEvent,
  LLMStreamTurnOptions,
} from "./types.js";

interface ClaudeStreamLine {
  type?: string;
  subtype?: string;
  session_id?: string;
  event?: {
    type?: string;
    content_block?: { type?: string; name?: string; id?: string };
    delta?: {
      type?: string;
      text?: string;
    };
  };
  message?: {
    content?: Array<{
      type?: string;
      text?: string;
      name?: string;
      id?: string;
      input?: Record<string, unknown>;
    }>;
  };
  stop_reason?: string;
}

const CLI_AUTH_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_API_KEY",
  "LLM_AUTH_TOKEN",
];

function envForCliAuth(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of CLI_AUTH_ENV_KEYS) {
    delete env[key];
  }
  return env;
}

export class ClaudeCliProvider implements LLMProvider {
  readonly kind = "claude-cli" as const;
  readonly supportsFlootTools = false;

  constructor(
    private readonly config: ClaudeCliModelConfig,
    private readonly cwd: string
  ) {}

  async *streamTurn(
    options: LLMStreamTurnOptions
  ): AsyncGenerator<LLMStreamEvent> {
    const args = [
      "-p",
      options.latestUserMessage,
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--model",
      this.config.model,
    ];

    if (options.system) {
      args.push("--append-system-prompt", options.system);
    }
    if (this.config.max_turns !== undefined) {
      args.push("--max-turns", String(this.config.max_turns));
    }
    if (this.config.permission_mode) {
      args.push("--permission-mode", this.config.permission_mode);
    }
    if (options.providerSessionId) {
      args.push("--resume", options.providerSessionId);
    }

    const binary = this.config.binary ?? "claude";
    const child = spawn(binary, args, {
      cwd: this.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      env: envForCliAuth(),
    }) as ChildProcessWithoutNullStreams;

    const onAbort = () => {
      if (!child.killed) child.kill("SIGTERM");
    };
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    const rl = createInterface({ input: child.stdout });
    const pendingLines: ClaudeStreamLine[] = [];
    let resolveNext: (() => void) | null = null;
    let closed = false;
    const errorRef: { current: Error | null } = { current: null };

    const notify = () => {
      if (resolveNext) {
        const resolve = resolveNext;
        resolveNext = null;
        resolve();
      }
    };

    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        pendingLines.push(JSON.parse(line) as ClaudeStreamLine);
        notify();
      } catch (err) {
        errorRef.current =
          err instanceof Error
            ? err
            : new Error("Failed to parse Claude CLI output");
        notify();
      }
    });

    rl.on("close", () => {
      closed = true;
      notify();
    });

    const exitPromise = new Promise<void>((resolve) => {
      child.on("close", (code) => {
        if (code !== 0 && !errorRef.current) {
          errorRef.current = new Error(
            `Claude CLI exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`
          );
        }
        closed = true;
        notify();
        resolve();
      });
      child.on("error", (err) => {
        errorRef.current = err;
        closed = true;
        notify();
        resolve();
      });
    });

    let textStarted = false;
    const announcedToolIds = new Set<string>();

    while (pendingLines.length > 0 || !closed) {
      const parsed = pendingLines.shift();
      if (!parsed) {
        if (closed) break;
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });
        continue;
      }

      if (parsed.type === "system" && parsed.session_id) {
        yield { type: "provider_session", sessionId: parsed.session_id };
      }

      if (parsed.type === "result" && parsed.session_id) {
        yield { type: "provider_session", sessionId: parsed.session_id };
      }

      if (parsed.type === "stream_event" && parsed.event) {
        const event = parsed.event;
        switch (event.type) {
          case "content_block_start":
            if (event.content_block?.type === "text") {
              textStarted = true;
              yield { type: "text_start" };
            }
            break;
          case "content_block_delta":
            if (event.delta?.type === "text_delta" && event.delta.text) {
              if (!textStarted) {
                textStarted = true;
                yield { type: "text_start" };
              }
              yield { type: "text_delta", text: event.delta.text };
            }
            break;
          case "content_block_stop":
            if (textStarted) {
              yield { type: "text_end" };
              textStarted = false;
            }
            break;
        }
      }

      if (parsed.type === "assistant" && parsed.message?.content) {
        for (const block of parsed.message.content) {
          // Text is streamed via stream_event; assistant messages repeat it in full.
          if (
            block.type === "tool_use" &&
            block.id &&
            block.name &&
            !announcedToolIds.has(block.id)
          ) {
            announcedToolIds.add(block.id);
            yield {
              type: "tool_call",
              id: block.id,
              name: block.name,
              input: block.input ?? {},
            };
          }
        }
      }
    }

    await exitPromise;

    if (textStarted) {
      yield { type: "text_end" };
    }

    const finalError = errorRef.current as Error | null;
    if (finalError) {
      yield {
        type: "turn_end",
        stopReason: "error",
        error: finalError.message,
      };
      return;
    }

    yield { type: "turn_end", stopReason: "end_turn" };
  }
}
