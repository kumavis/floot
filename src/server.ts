import "dotenv/config";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";
import { writeFile, readFile, unlink, mkdir } from "fs/promises";
import { execFile, spawn, exec } from "child_process";
import { promisify } from "util";
import vm from "vm";
import { randomUUID } from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";

const execFileAsync = promisify(execFile);
const anthropic = new Anthropic({
  apiKey: process.env.LLM_AUTH_TOKEN,
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const WHISPER_MODEL = process.env.WHISPER_MODEL || "base";
const UPLOADS_DIR = path.resolve(__dirname, "..", "uploads");
const TTS_VOICE = process.env.TTS_VOICE || "Fiona (Enhanced)";

await mkdir(UPLOADS_DIR, { recursive: true });

const app = express();
app.use(express.static(path.join(__dirname, "public")));

const messageStore = new Map<string, { role: string; content: string }>();

app.get("/api/tts/:id", async (req, res) => {
  const msg = messageStore.get(req.params.id);
  if (!msg) {
    res.status(404).json({ error: "Message not found" });
    return;
  }

  const text = msg.content;
  if (!text) {
    res.status(400).json({ error: "Empty message" });
    return;
  }

  const tmpId = randomUUID();
  const aiffPath = path.join(UPLOADS_DIR, `${tmpId}.aiff`);

  try {
    await execFileAsync("say", ["-v", TTS_VOICE, "-o", aiffPath, text]);
  } catch (err) {
    console.error("say error:", err);
    if (!res.headersSent) res.status(500).json({ error: "TTS synthesis failed" });
    return;
  }

  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Transfer-Encoding", "chunked");
  res.setHeader("Cache-Control", "no-cache");

  const ffmpegProc = spawn("ffmpeg", [
    "-i", aiffPath,
    "-codec:a", "libmp3lame",
    "-q:a", "4",
    "-f", "mp3",
    "pipe:1",
  ], { stdio: ["ignore", "pipe", "pipe"] });

  ffmpegProc.stdout.pipe(res);
  ffmpegProc.stderr.on("data", () => {});

  ffmpegProc.on("close", () => {
    unlink(aiffPath).catch(() => {});
    if (!res.writableEnded) res.end();
  });

  ffmpegProc.on("error", (err) => {
    console.error("ffmpeg error:", err);
    unlink(aiffPath).catch(() => {});
    if (!res.headersSent) res.status(500).json({ error: "TTS encoding failed" });
  });

  req.on("close", () => {
    ffmpegProc.kill();
    unlink(aiffPath).catch(() => {});
  });
});

const server = createServer(app);
const wss = new WebSocketServer({ server });

function send(ws: WebSocket, data: Record<string, unknown>) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

async function transcribe(audioPath: string): Promise<string> {
  const { stderr } = await execFileAsync("whisper", [
    audioPath,
    "--model",
    WHISPER_MODEL,
    "--output_format",
    "txt",
    "--output_dir",
    UPLOADS_DIR,
  ]);

  if (stderr) {
    console.log("[whisper]", stderr);
  }

  const baseName = path.basename(audioPath, path.extname(audioPath));
  const txtPath = path.join(UPLOADS_DIR, `${baseName}.txt`);
  const transcript = await readFile(txtPath, "utf-8");
  await Promise.all([unlink(audioPath), unlink(txtPath)]).catch(() => {});
  return transcript.trim();
}

const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  "You are a helpful voice assistant. The user is speaking to you via voice transcription. Be concise, warm, and conversational. Keep responses short unless asked for detail. You have access to tools for running JavaScript and shell commands on the user's machine.";

const TOOLS: Anthropic.Tool[] = [
  {
    name: "eval_js",
    description:
      "Evaluate JavaScript code in a full Node.js environment. Has access to all Node.js built-in modules (fs, path, http, etc). Returns the result of the last expression, or stdout output. Use for calculations, file operations, data processing, etc.",
    input_schema: {
      type: "object" as const,
      properties: {
        code: {
          type: "string",
          description: "The JavaScript code to evaluate",
        },
      },
      required: ["code"],
    },
  },
  {
    name: "run_shell",
    description:
      "Run a shell command (bash) and return its stdout and stderr. Use for system commands, file listing, git operations, package management, etc.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: {
          type: "string",
          description: "The shell command to run",
        },
        cwd: {
          type: "string",
          description: "Working directory (optional, defaults to project root)",
        },
      },
      required: ["command"],
    },
  },
];

const execAsync = promisify(exec);
const PROJECT_ROOT = path.resolve(__dirname, "..");

async function executeTool(
  name: string,
  input: Record<string, string>
): Promise<string> {
  if (name === "eval_js") {
    try {
      const script = new vm.Script(input.code, { filename: "eval.js" });
      const context = vm.createContext({
        ...globalThis,
        require: (await import("module")).createRequire(
          path.join(PROJECT_ROOT, "eval.js")
        ),
        console: {
          log: (...args: unknown[]) => output.push(args.map(String).join(" ")),
          error: (...args: unknown[]) =>
            output.push("ERROR: " + args.map(String).join(" ")),
          warn: (...args: unknown[]) =>
            output.push("WARN: " + args.map(String).join(" ")),
          info: (...args: unknown[]) => output.push(args.map(String).join(" ")),
        },
        __dirname: PROJECT_ROOT,
        __filename: path.join(PROJECT_ROOT, "eval.js"),
        process,
        Buffer,
        setTimeout,
        setInterval,
        clearTimeout,
        clearInterval,
      });
      const output: string[] = [];
      const result = script.runInContext(context, { timeout: 30_000 });
      if (output.length > 0) {
        return output.join("\n") + (result !== undefined ? "\n→ " + String(result) : "");
      }
      return result !== undefined ? String(result) : "(no output)";
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (name === "run_shell") {
    try {
      const cwd = input.cwd || PROJECT_ROOT;
      const { stdout, stderr } = await execAsync(input.command, {
        cwd,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      let result = "";
      if (stdout.trim()) result += stdout.trim();
      if (stderr.trim()) result += (result ? "\n\nSTDERR:\n" : "STDERR:\n") + stderr.trim();
      return result || "(no output)";
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message: string };
      let result = `Exit code error: ${e.message}`;
      if (e.stdout) result += "\n\nSTDOUT:\n" + e.stdout;
      if (e.stderr) result += "\n\nSTDERR:\n" + e.stderr;
      return result;
    }
  }

  return `Unknown tool: ${name}`;
}

type ContentBlock =
  | Anthropic.TextBlockParam
  | Anthropic.ToolUseBlockParam
  | Anthropic.ToolResultBlockParam;

type Message = {
  role: "user" | "assistant";
  content: string | ContentBlock[];
};

wss.on("connection", (ws) => {
  console.log("Client connected");
  const history: Message[] = [];

  async function handleUserMessage(text: string, userMsgId: string) {
    history.push({ role: "user", content: text });
    messageStore.set(userMsgId, { role: "user", content: text });

    const assistantMsgId = randomUUID();
    send(ws, { type: "claude_start", msgId: assistantMsgId });

    const model = process.env.LLM_MODEL || "claude-opus-4-5-20251101";
    let fullTextResponse = "";

    while (true) {
      const stream = anthropic.messages.stream({
        model,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages: history,
      });

      const contentBlocks: ContentBlock[] = [];
      let currentToolId = "";
      let currentToolName = "";
      let currentToolInput = "";

      for await (const event of stream) {
        switch (event.type) {
          case "content_block_start":
            if (event.content_block.type === "tool_use") {
              currentToolId = event.content_block.id;
              currentToolName = event.content_block.name;
              currentToolInput = "";
              send(ws, {
                type: "tool_start",
                tool: currentToolName,
              });
            }
            break;

          case "content_block_delta":
            if (event.delta.type === "text_delta") {
              fullTextResponse += event.delta.text;
              send(ws, { type: "claude_delta", text: event.delta.text });
            } else if (event.delta.type === "input_json_delta") {
              currentToolInput += event.delta.partial_json;
            }
            break;

          case "content_block_stop": {
            const finalMsg = await stream.finalMessage();
            const block = finalMsg.content[event.index];
            if (block.type === "text") {
              contentBlocks.push(block);
            } else if (block.type === "tool_use") {
              contentBlocks.push(block);
            }
            break;
          }
        }
      }

      history.push({ role: "assistant", content: contentBlocks });

      const finalMessage = await stream.finalMessage();
      if (finalMessage.stop_reason !== "tool_use") {
        break;
      }

      const toolUseBlocks = contentBlocks.filter(
        (b): b is Anthropic.ToolUseBlockParam => b.type === "tool_use"
      );
      const toolResults: ContentBlock[] = [];

      for (const toolUse of toolUseBlocks) {
        console.log(`[tool] ${toolUse.name}:`, JSON.stringify(toolUse.input));
        send(ws, {
          type: "tool_exec",
          tool: toolUse.name,
          input: toolUse.input,
        });

        const result = await executeTool(
          toolUse.name as string,
          toolUse.input as Record<string, string>
        );
        console.log(`[tool result] ${result.substring(0, 200)}`);

        send(ws, {
          type: "tool_result",
          tool: toolUse.name,
          result: result.substring(0, 500),
        });

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id as string,
          content: result,
        });
      }

      history.push({ role: "user", content: toolResults });
    }

    messageStore.set(assistantMsgId, {
      role: "assistant",
      content: fullTextResponse,
    });

    send(ws, {
      type: "claude_done",
      msgId: assistantMsgId,
      text: fullTextResponse,
    });
  }

  ws.on("message", async (data, isBinary) => {
    try {
      if (isBinary) {
        const msgId = randomUUID();
        const audioPath = path.join(UPLOADS_DIR, `${msgId}.webm`);
        const audioBuffer = Buffer.isBuffer(data)
          ? data
          : Buffer.from(data as ArrayBuffer);

        send(ws, { type: "status", message: "Transcribing..." });
        await writeFile(audioPath, audioBuffer);
        const transcript = await transcribe(audioPath);

        if (!transcript || transcript === "") {
          send(ws, { type: "status", message: "" });
          return;
        }

        send(ws, { type: "transcript", text: transcript, msgId });
        await handleUserMessage(transcript, msgId);
      } else {
        const msg = JSON.parse(data.toString());
        if (msg.type === "text" && msg.content?.trim()) {
          const msgId = randomUUID();
          send(ws, { type: "transcript", text: msg.content.trim(), msgId });
          await handleUserMessage(msg.content.trim(), msgId);
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Error:", message);
      send(ws, { type: "error", message });
    }
  });

  ws.on("close", () => {
    console.log("Client disconnected");
  });
});

server.listen(PORT, () => {
  console.log(`STT server running at http://localhost:${PORT}`);
});
