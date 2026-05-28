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
import {
  SessionStore,
  type ContentBlock,
  type SessionDetail,
  type SessionSummary,
} from "./state/session-store.js";
import { SayTTSProvider, type SayTTSStream } from "./tts/index.js";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

const anthropic = new Anthropic({
  apiKey: process.env.LLM_AUTH_TOKEN,
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const CLIENT_DIST_DIR = path.resolve(PROJECT_ROOT, "dist/public");

const PORT = Number(process.env.PORT) || 3000;
const WHISPER_MODEL = process.env.WHISPER_MODEL || "base";
const UPLOADS_DIR = path.resolve(__dirname, "..", "uploads");
const TTS_VOICE = process.env.TTS_VOICE || "Fiona (Enhanced)";
const MIN_AUDIO_BYTES = 1024;
const BROADCAST_THROTTLE_MS = 50;

await mkdir(UPLOADS_DIR, { recursive: true });

async function ensureUploadsDir() {
  await mkdir(UPLOADS_DIR, { recursive: true });
}

const app = express();
app.use(express.static(CLIENT_DIST_DIR));

const store = new SessionStore();
const ttsProvider = new SayTTSProvider(UPLOADS_DIR, TTS_VOICE);

// Track active TTS streams per message so we can stream audio for in-progress responses
interface ActiveTTSState {
  stream: SayTTSStream;
  audioChunks: Buffer[];
  done: boolean;
  waiters: Array<() => void>; // Resolve functions for pending waitForChunk calls
}
const activeTTSByMessage = new Map<string, ActiveTTSState>();

// ----- TTS endpoint -----
// This endpoint streams audio for a message. If the message is still being generated,
// it will wait for audio chunks as they become available.
app.get("/api/tts/:id", async (req, res) => {
  await ensureUploadsDir();

  const messageId = req.params.id;
  const lookup = store.getAssistantTextById(messageId);
  if (!lookup) {
    res.status(404).json({ error: "Message not found" });
    return;
  }

  // Check if there's an active TTS stream for this message (still generating)
  const activeState = activeTTSByMessage.get(messageId);

  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Transfer-Encoding", "chunked");
  res.setHeader("Cache-Control", "no-cache");

  if (activeState) {
    // Stream audio chunks as they become available
    let chunkIndex = 0;
    
    const sendAvailableChunks = () => {
      while (chunkIndex < activeState.audioChunks.length) {
        res.write(activeState.audioChunks[chunkIndex]);
        chunkIndex++;
      }
    };

    const waitForNextChunk = (): Promise<void> => {
      return new Promise((resolve) => {
        // If there are already chunks available or done, resolve immediately
        if (chunkIndex < activeState.audioChunks.length || activeState.done) {
          resolve();
          return;
        }
        // Otherwise wait for a signal
        activeState.waiters.push(resolve);
      });
    };

    // Stream loop
    while (!req.socket.destroyed) {
      sendAvailableChunks();
      
      if (activeState.done && chunkIndex >= activeState.audioChunks.length) {
        // All done
        break;
      }
      
      // Wait for more chunks or completion
      await waitForNextChunk();
    }
    
    res.end();
    return;
  }

  // No active stream - message is complete, generate all audio at once (existing behavior)
  const tmpId = randomUUID();
  const aiffPath = path.join(UPLOADS_DIR, `${tmpId}.aiff`);

  try {
    await execFileAsync("say", [
      "-v",
      TTS_VOICE,
      "-o",
      aiffPath,
      lookup.text,
    ]);
  } catch (err) {
    console.error("say error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "TTS synthesis failed" });
    }
    return;
  }

  const ffmpegProc = spawn(
    "ffmpeg",
    [
      "-i",
      aiffPath,
      "-codec:a",
      "libmp3lame",
      "-q:a",
      "4",
      "-f",
      "mp3",
      "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );

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

// ----- Per-connection state -----
interface Connection {
  ws: WebSocket;
  selectedSessionId: string | null;
}

const connections = new Set<Connection>();

function sendJson(ws: WebSocket, data: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcastJsonToSession(sessionId: string, data: Record<string, unknown>): void {
  for (const conn of connections) {
    if (conn.selectedSessionId === sessionId) {
      sendJson(conn.ws, data);
    }
  }
}

function buildInit(conn: Connection) {
  const detail = conn.selectedSessionId
    ? store.getDetail(conn.selectedSessionId) ?? null
    : null;
  return {
    type: "state/init",
    sessions: store.listSummaries(),
    detail,
  };
}

function sendInit(conn: Connection): void {
  sendJson(conn.ws, buildInit(conn));
}

function sendSessionUpdated(conn: Connection): void {
  const detail = conn.selectedSessionId
    ? store.getDetail(conn.selectedSessionId) ?? null
    : null;
  sendJson(conn.ws, { type: "state/session_updated", detail });
}

function broadcastSessionsList(): void {
  const sessions: SessionSummary[] = store.listSummaries();
  for (const conn of connections) {
    sendJson(conn.ws, { type: "state/sessions_updated", sessions });
  }
}

function broadcastSessionUpdate(sessionId: string): void {
  const detail: SessionDetail | null = store.getDetail(sessionId) ?? null;
  for (const conn of connections) {
    if (conn.selectedSessionId !== sessionId) continue;
    sendJson(conn.ws, { type: "state/session_updated", detail });
  }
}

function sendError(conn: Connection, message: string): void {
  sendJson(conn.ws, { type: "state/error", message });
}

// ----- Throttled broadcasting from store events -----
let sessionsListDirty = false;
const dirtySessionIds = new Set<string>();
let flushScheduled = false;

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  setTimeout(() => {
    flushScheduled = false;
    if (sessionsListDirty) {
      sessionsListDirty = false;
      broadcastSessionsList();
    }
    if (dirtySessionIds.size > 0) {
      const ids = [...dirtySessionIds];
      dirtySessionIds.clear();
      for (const id of ids) broadcastSessionUpdate(id);
    }
  }, BROADCAST_THROTTLE_MS);
}

store.on("sessionsUpdated", () => {
  sessionsListDirty = true;
  scheduleFlush();
});

store.on("sessionUpdated", (sessionId: string) => {
  dirtySessionIds.add(sessionId);
  scheduleFlush();
});

store.on("sessionDeleted", (sessionId: string) => {
  for (const conn of connections) {
    if (conn.selectedSessionId === sessionId) {
      conn.selectedSessionId = null;
      sendJson(conn.ws, { type: "state/session_updated", detail: null });
    }
  }
});

// ----- LLM + tools -----
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

async function executeTool(
  name: string,
  input: Record<string, string>
): Promise<string> {
  if (name === "eval_js") {
    try {
      const script = new vm.Script(input.code, { filename: "eval.js" });
      const output: string[] = [];
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
      const result = script.runInContext(context, { timeout: 30_000 });
      if (output.length > 0) {
        return (
          output.join("\n") +
          (result !== undefined ? "\n\u2192 " + String(result) : "")
        );
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
      if (stderr.trim())
        result += (result ? "\n\nSTDERR:\n" : "STDERR:\n") + stderr.trim();
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

async function transcribe(audioPath: string): Promise<string> {
  await ensureUploadsDir();
  const baseName = path.basename(audioPath, path.extname(audioPath));
  const txtPath = path.join(UPLOADS_DIR, `${baseName}.txt`);

  try {
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

    const transcript = await readFile(txtPath, "utf-8");
    return transcript.trim();
  } finally {
    await Promise.all([unlink(audioPath), unlink(txtPath)]).catch(() => {});
  }
}

// ----- TTS streaming helpers -----
function startTTSForMessage(messageId: string): ActiveTTSState {
  const stream = ttsProvider.createStream();
  const state: ActiveTTSState = {
    stream,
    audioChunks: [],
    done: false,
    waiters: [],
  };

  const wakeWaiters = () => {
    const toNotify = state.waiters;
    state.waiters = [];
    for (const resolve of toNotify) resolve();
  };

  // Cleanup is idempotent: both `done` and `error` may fire for the same
  // stream, but the map entry must only be scheduled for deletion once.
  let cleanupScheduled = false;
  const scheduleCleanup = () => {
    if (cleanupScheduled) return;
    cleanupScheduled = true;
    // Delay so late-arriving HTTP requests can still drain audioChunks.
    setTimeout(() => {
      activeTTSByMessage.delete(messageId);
    }, 30000);
  };

  stream.on("audio", (chunk: Buffer) => {
    state.audioChunks.push(chunk);
    wakeWaiters();
  });

  stream.on("done", () => {
    state.done = true;
    wakeWaiters();
    scheduleCleanup();
  });

  stream.on("error", (err: Error) => {
    console.error("[TTS stream error]", err);
    state.done = true;
    wakeWaiters();
    scheduleCleanup();
  });

  activeTTSByMessage.set(messageId, state);
  return state;
}

// ----- Orchestration -----
async function runAssistantTurn(sessionId: string): Promise<void> {
  store.setStatus(sessionId, "streaming");
  const model = process.env.LLM_MODEL || "claude-opus-4-5-20251101";

  try {
    while (true) {
      const history = store.getHistory(sessionId);
      if (!history) return;

      const stream = anthropic.messages.stream({
        model,
        max_tokens: 64000,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages: history,
      });

      const contentBlocks: ContentBlock[] = [];
      let currentAssistantMsgId: string | null = null;
      let currentTTSState: ActiveTTSState | null = null;

      for await (const event of stream) {
        switch (event.type) {
          case "content_block_start":
            if (event.content_block.type === "text") {
              const msg = store.beginAssistantText(sessionId);
              currentAssistantMsgId = msg?.id ?? null;
              // Start TTS streaming for this message
              if (currentAssistantMsgId) {
                currentTTSState = startTTSForMessage(currentAssistantMsgId);
              }
            }
            break;

          case "content_block_delta":
            if (event.delta.type === "text_delta" && currentAssistantMsgId) {
              store.appendAssistantDelta(
                sessionId,
                currentAssistantMsgId,
                event.delta.text
              );
              // Feed text to the TTS stream
              if (currentTTSState) {
                currentTTSState.stream.write(event.delta.text);
              }
            }
            break;

          case "content_block_stop": {
            const finalMsg = await stream.finalMessage();
            const block = finalMsg.content[event.index];
            if (block.type === "text") {
              contentBlocks.push(block);
              // End the TTS stream for this text block
              if (currentTTSState) {
                currentTTSState.stream.end();
                currentTTSState = null;
              }
              currentAssistantMsgId = null;
            } else if (block.type === "tool_use") {
              contentBlocks.push(block);
              // Input is streamed via input_json_delta; only complete at block stop.
              store.appendToolCall(sessionId, block.name, block.input ?? {});
            }
            break;
          }
        }
      }

      store.pushAssistantHistoryBlocks(sessionId, contentBlocks);

      const finalMessage = await stream.finalMessage();
      if (finalMessage.stop_reason !== "tool_use") {
        break;
      }

      const toolUseBlocks = contentBlocks.filter(
        (b): b is Anthropic.ToolUseBlockParam => b.type === "tool_use"
      );
      const toolResults: ContentBlock[] = [];

      for (const toolUse of toolUseBlocks) {
        const result = await executeTool(
          toolUse.name,
          toolUse.input as Record<string, string>
        );
        store.appendToolResult(sessionId, toolUse.name, result);
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: result,
        });
      }

      store.pushUserHistoryBlocks(sessionId, toolResults);
    }

    store.setStatus(sessionId, "idle");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[assistant] error:", message);
    store.appendError(sessionId, message);
    store.setStatus(sessionId, "error", message);
  }
}

async function handleTextMessage(
  conn: Connection,
  content: string
): Promise<void> {
  const sessionId = conn.selectedSessionId;
  if (!sessionId || !store.hasSession(sessionId)) {
    sendError(conn, "No session selected. Create or select a session first.");
    return;
  }
  const trimmed = content.trim();
  if (!trimmed) return;

  store.appendUserText(sessionId, trimmed);
  await runAssistantTurn(sessionId);
}

async function handleAudioMessage(
  conn: Connection,
  buffer: Buffer
): Promise<void> {
  const sessionId = conn.selectedSessionId;
  if (!sessionId || !store.hasSession(sessionId)) {
    sendError(conn, "No session selected. Create or select a session first.");
    return;
  }
  if (buffer.length < MIN_AUDIO_BYTES) {
    return;
  }

  await ensureUploadsDir();
  const tmpId = randomUUID();
  const audioPath = path.join(UPLOADS_DIR, `${tmpId}.webm`);
  await writeFile(audioPath, buffer);

  store.setStatus(sessionId, "transcribing");

  let transcript = "";
  try {
    transcript = await transcribe(audioPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const looksLikeBadAudio =
      msg.includes("Invalid data found when processing input") ||
      msg.includes("EBML header parsing failed") ||
      msg.includes("Failed to load audio");

    if (looksLikeBadAudio) {
      console.warn("[stt] Ignoring invalid audio payload");
      store.setStatus(sessionId, "idle");
      return;
    }

    store.appendError(sessionId, `Transcription failed: ${msg}`);
    store.setStatus(sessionId, "error", msg);
    return;
  }

  if (!transcript) {
    store.setStatus(sessionId, "idle");
    return;
  }

  store.appendUserText(sessionId, transcript);
  await runAssistantTurn(sessionId);
}

// ----- WS command dispatcher -----
wss.on("connection", (ws) => {
  const conn: Connection = { ws, selectedSessionId: null };
  connections.add(conn);
  console.log("[ws] connected");

  sendInit(conn);

  ws.on("message", async (data, isBinary) => {
    try {
      if (isBinary) {
        const buffer = Buffer.isBuffer(data)
          ? data
          : Buffer.from(data as ArrayBuffer);
        await handleAudioMessage(conn, buffer);
        return;
      }

      const msg = JSON.parse(data.toString());
      switch (msg.type) {
        case "session/list":
          sendJson(ws, {
            type: "state/sessions_updated",
            sessions: store.listSummaries(),
          });
          break;

        case "session/create": {
          const detail = store.createSession();
          conn.selectedSessionId = detail.id;
          sendSessionUpdated(conn);
          break;
        }

        case "session/select": {
          const sessionId = String(msg.sessionId ?? "");
          if (!store.hasSession(sessionId)) {
            sendError(conn, "Session not found");
            return;
          }
          conn.selectedSessionId = sessionId;
          sendSessionUpdated(conn);
          break;
        }

        case "session/delete": {
          const sessionId = String(msg.sessionId ?? "");
          if (!store.deleteSession(sessionId)) {
            sendError(conn, "Session not found");
          }
          break;
        }

        case "message/send_text": {
          await handleTextMessage(conn, String(msg.content ?? ""));
          break;
        }

        default:
          sendError(conn, `Unknown command: ${msg.type}`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[ws] error:", message);
      sendError(conn, message);
    }
  });

  ws.on("close", () => {
    connections.delete(conn);
    console.log("[ws] disconnected");
  });
});

server.listen(PORT, () => {
  console.log(`Floot server running at http://localhost:${PORT}`);
});
