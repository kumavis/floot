import "dotenv/config";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";
import { writeFile, readFile, unlink, mkdir } from "fs/promises";
import { createWriteStream } from "fs";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import vm from "vm";
import { randomUUID } from "crypto";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import {
  SessionStore,
  type ContentBlock,
  type SessionDetail,
  type SessionSummary,
} from "./state/session-store.js";
import { SayTTSProvider, type SayTTSStream } from "./tts/index.js";
import { ModelsConfig } from "./config/models.js";
import { createLLMProvider, type LLMStreamEvent } from "./llm/index.js";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const CLIENT_DIST_DIR = path.resolve(PROJECT_ROOT, "dist/public");

const PORT = Number(process.env.PORT) || 3000;
const WHISPER_MODEL = process.env.WHISPER_MODEL || "base";
const UPLOADS_DIR = path.resolve(__dirname, "..", "uploads");
const SHELL_LOG_DIR = path.join(os.tmpdir(), "floot-shell-logs");
const SHELL_HEAD_BYTES = 32 * 1024;
const SHELL_TIMEOUT_MS = 30_000;
const TTS_VOICE = process.env.TTS_VOICE || "Fiona (Enhanced)";
const MIN_AUDIO_BYTES = 1024;
const BROADCAST_THROTTLE_MS = 50;

await mkdir(UPLOADS_DIR, { recursive: true });
await mkdir(SHELL_LOG_DIR, { recursive: true });

const modelsConfig = await ModelsConfig.load();

async function ensureUploadsDir() {
  await mkdir(UPLOADS_DIR, { recursive: true });
}

const app = express();
app.use(express.static(CLIENT_DIST_DIR));

const store = new SessionStore();
const ttsProvider = new SayTTSProvider(UPLOADS_DIR, TTS_VOICE);

interface ActiveTTSState {
  stream: SayTTSStream;
  audioChunks: Buffer[];
  done: boolean;
  waiters: Array<() => void>;
}
const activeTTSByMessage = new Map<string, ActiveTTSState>();
const activeTurnControllers = new Map<string, AbortController>();

app.get("/api/tts/:id", async (req, res) => {
  await ensureUploadsDir();

  const messageId = req.params.id;
  const lookup = store.getAssistantTextById(messageId);
  if (!lookup) {
    res.status(404).json({ error: "Message not found" });
    return;
  }

  const activeState = activeTTSByMessage.get(messageId);

  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Transfer-Encoding", "chunked");
  res.setHeader("Cache-Control", "no-cache");

  if (activeState) {
    let chunkIndex = 0;

    const sendAvailableChunks = () => {
      while (chunkIndex < activeState.audioChunks.length) {
        res.write(activeState.audioChunks[chunkIndex]);
        chunkIndex++;
      }
    };

    const waitForNextChunk = (): Promise<void> => {
      return new Promise((resolve) => {
        if (chunkIndex < activeState.audioChunks.length || activeState.done) {
          resolve();
          return;
        }
        activeState.waiters.push(resolve);
      });
    };

    while (!req.socket.destroyed) {
      sendAvailableChunks();

      if (activeState.done && chunkIndex >= activeState.audioChunks.length) {
        break;
      }

      await waitForNextChunk();
    }

    res.end();
    return;
  }

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
    models: modelsConfig.getModelsCatalog(),
    defaultModelId: modelsConfig.getDefaultModelId(),
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

async function runShellCommand(
  command: string,
  cwd: string,
  signal?: AbortSignal
): Promise<string> {
  const id = randomUUID();
  const stdoutPath = path.join(SHELL_LOG_DIR, `${id}.stdout.log`);
  const stderrPath = path.join(SHELL_LOG_DIR, `${id}.stderr.log`);

  const stdoutFile = createWriteStream(stdoutPath);
  const stderrFile = createWriteStream(stderrPath);

  let stdoutHead: Buffer = Buffer.alloc(0);
  let stderrHead: Buffer = Buffer.alloc(0);
  let stdoutTotal = 0;
  let stderrTotal = 0;

  const appendHead = (head: Buffer, chunk: Buffer): Buffer => {
    if (head.length >= SHELL_HEAD_BYTES) return head;
    const need = SHELL_HEAD_BYTES - head.length;
    const slice = chunk.length <= need ? chunk : chunk.subarray(0, need);
    return Buffer.concat([head, slice]);
  };

  const child = spawn(command, {
    cwd,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutTotal += chunk.length;
    stdoutHead = appendHead(stdoutHead, chunk);
    stdoutFile.write(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrTotal += chunk.length;
    stderrHead = appendHead(stderrHead, chunk);
    stderrFile.write(chunk);
  });

  let timedOut = false;
  let interrupted = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, SHELL_TIMEOUT_MS);

  const onAbort = () => {
    interrupted = true;
    if (!child.killed) child.kill("SIGTERM");
  };
  if (signal) {
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  const exit = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    spawnError?: Error;
  }>((resolve) => {
    child.on("close", (code, signal) => {
      clearTimeout(timeoutHandle);
      resolve({ code, signal });
    });
    child.on("error", (spawnError) => {
      clearTimeout(timeoutHandle);
      resolve({ code: null, signal: null, spawnError });
    });
  });
  if (signal) signal.removeEventListener("abort", onAbort);

  await Promise.all([
    new Promise<void>((resolve) => stdoutFile.end(resolve)),
    new Promise<void>((resolve) => stderrFile.end(resolve)),
  ]);

  const stdoutTruncated = stdoutTotal > stdoutHead.length;
  const stderrTruncated = stderrTotal > stderrHead.length;

  if (!stdoutTruncated) await unlink(stdoutPath).catch(() => {});
  if (!stderrTruncated) await unlink(stderrPath).catch(() => {});

  const parts: string[] = [];

  if (exit.spawnError) {
    parts.push(`Error spawning command: ${exit.spawnError.message}`);
  } else if (interrupted) {
    parts.push("[interrupted by user before completion]");
  } else if (timedOut) {
    parts.push(`Command timed out after ${SHELL_TIMEOUT_MS}ms (SIGTERM sent)`);
  } else if (exit.code !== 0) {
    parts.push(
      `Exit code ${exit.code}${exit.signal ? ` (signal ${exit.signal})` : ""}`
    );
  }

  const stdoutStr = stdoutHead.toString("utf8").trim();
  if (stdoutStr) {
    let block = stdoutStr;
    if (stdoutTruncated) {
      const omitted = stdoutTotal - stdoutHead.length;
      block += `\n\n[stdout truncated: ${omitted} bytes omitted. Full output at ${stdoutPath} — use tail/grep/sed to inspect]`;
    }
    parts.push(block);
  } else if (stdoutTruncated) {
    parts.push(`[stdout truncated; full output at ${stdoutPath}]`);
  }

  const stderrStr = stderrHead.toString("utf8").trim();
  if (stderrStr) {
    let block = "STDERR:\n" + stderrStr;
    if (stderrTruncated) {
      const omitted = stderrTotal - stderrHead.length;
      block += `\n\n[stderr truncated: ${omitted} bytes omitted. Full output at ${stderrPath} — use tail/grep/sed to inspect]`;
    }
    parts.push(block);
  } else if (stderrTruncated) {
    parts.push(`[stderr truncated; full output at ${stderrPath}]`);
  }

  return parts.join("\n\n") || "(no output)";
}

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  signal?: AbortSignal
): Promise<string> {
  if (name === "eval_js") {
    try {
      const code = String(input.code ?? "");
      const script = new vm.Script(code, { filename: "eval.js" });
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
    const command = String(input.command ?? "");
    const cwd = input.cwd ? String(input.cwd) : PROJECT_ROOT;
    return runShellCommand(command, cwd, signal);
  }

  return `Unknown tool: ${name}`;
}

async function transcribe(
  audioPath: string,
  signal?: AbortSignal
): Promise<string> {
  await ensureUploadsDir();
  const baseName = path.basename(audioPath, path.extname(audioPath));
  const txtPath = path.join(UPLOADS_DIR, `${baseName}.txt`);

  try {
    const { stderr } = await execFileAsync(
      "whisper",
      [
        audioPath,
        "--model",
        WHISPER_MODEL,
        "--output_format",
        "txt",
        "--output_dir",
        UPLOADS_DIR,
      ],
      { signal }
    );

    if (stderr) {
      console.log("[whisper]", stderr);
    }

    const transcript = await readFile(txtPath, "utf-8");
    return transcript.trim();
  } finally {
    await Promise.all([unlink(audioPath), unlink(txtPath)]).catch(() => {});
  }
}

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

  let cleanupScheduled = false;
  const scheduleCleanup = () => {
    if (cleanupScheduled) return;
    cleanupScheduled = true;
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

async function consumeStreamEvent(
  sessionId: string,
  event: LLMStreamEvent,
  state: {
    contentBlocks: ContentBlock[];
    currentAssistantMsgId: string | null;
    currentTTSState: ActiveTTSState | null;
    currentText: string;
    stopReason: "end_turn" | "tool_use";
  }
): Promise<void> {
  switch (event.type) {
    case "provider_session":
      store.setProviderSessionId(sessionId, event.sessionId);
      break;
    case "text_start": {
      const msg = store.beginAssistantText(sessionId);
      state.currentAssistantMsgId = msg?.id ?? null;
      state.currentText = "";
      if (state.currentAssistantMsgId) {
        state.currentTTSState = startTTSForMessage(state.currentAssistantMsgId);
      }
      break;
    }
    case "text_delta":
      if (state.currentAssistantMsgId) {
        state.currentText += event.text;
        store.appendAssistantDelta(
          sessionId,
          state.currentAssistantMsgId,
          event.text
        );
        if (state.currentTTSState) {
          state.currentTTSState.stream.write(event.text);
        }
      }
      break;
    case "text_end":
      if (state.currentText) {
        state.contentBlocks.push({ type: "text", text: state.currentText });
        state.currentText = "";
      }
      if (state.currentTTSState) {
        state.currentTTSState.stream.end();
        state.currentTTSState = null;
      }
      state.currentAssistantMsgId = null;
      break;
    case "tool_call":
      state.contentBlocks.push({
        type: "tool_use",
        id: event.id,
        name: event.name,
        input: event.input,
      });
      store.appendToolCall(sessionId, event.name, event.input);
      break;
    case "turn_end":
      state.stopReason = event.stopReason;
      break;
  }
}

async function runAssistantTurn(
  sessionId: string,
  controller: AbortController = new AbortController()
): Promise<void> {
  store.setStatus(sessionId, "streaming");

  const modelId = store.getModelId(sessionId);
  if (!modelId) return;

  const modelConfig = modelsConfig.getModelConfig(modelId);
  const provider = createLLMProvider(modelConfig, PROJECT_ROOT);
  const systemPrompt = modelsConfig.getSystemPrompt(modelId);

  activeTurnControllers.set(sessionId, controller);
  const signal = controller.signal;

  let pendingToolUses: Array<{ id: string; name: string }> = [];
  const pendingToolResults: ContentBlock[] = [];

  try {
    while (true) {
      if (signal.aborted) break;

      const history = store.getHistory(sessionId);
      if (!history) return;

      const latestUserMessage = store.getLatestUserMessage(sessionId);
      if (!latestUserMessage) return;

      const stream = provider.streamTurn({
        system: systemPrompt,
        messages: history,
        latestUserMessage,
        providerSessionId: store.getProviderSessionId(sessionId),
        signal,
      });

      const streamState = {
        contentBlocks: [] as ContentBlock[],
        currentAssistantMsgId: null as string | null,
        currentTTSState: null as ActiveTTSState | null,
        currentText: "",
        stopReason: "end_turn" as "end_turn" | "tool_use",
      };

      try {
        for await (const event of stream) {
          await consumeStreamEvent(sessionId, event, streamState);
        }
      } finally {
        if (streamState.currentText) {
          streamState.contentBlocks.push({
            type: "text",
            text: streamState.currentText,
          });
          streamState.currentText = "";
        }
        if (streamState.currentTTSState) {
          if (signal.aborted) {
            streamState.currentTTSState.stream.abort();
          } else {
            streamState.currentTTSState.stream.end();
          }
          streamState.currentTTSState = null;
        }
      }

      if (streamState.contentBlocks.length > 0) {
        store.pushAssistantHistoryBlocks(sessionId, streamState.contentBlocks);
      }

      if (
        !provider.supportsFlootTools ||
        streamState.stopReason !== "tool_use"
      ) {
        break;
      }

      pendingToolUses = streamState.contentBlocks
        .filter(
          (block): block is Extract<ContentBlock, { type: "tool_use" }> =>
            block.type === "tool_use"
        )
        .map((b) => ({ id: b.id, name: b.name }));
      pendingToolResults.length = 0;

      for (const toolUse of streamState.contentBlocks) {
        if (toolUse.type !== "tool_use") continue;
        if (signal.aborted) break;
        const result = await executeTool(toolUse.name, toolUse.input, signal);
        store.appendToolResult(sessionId, toolUse.name, result);
        pendingToolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: result,
        });
        pendingToolUses = pendingToolUses.filter((p) => p.id !== toolUse.id);
      }

      if (pendingToolUses.length > 0) {
        for (const pending of pendingToolUses) {
          pendingToolResults.push({
            type: "tool_result",
            tool_use_id: pending.id,
            content: "[interrupted by user]",
          });
        }
        pendingToolUses = [];
      }

      store.pushUserHistoryBlocks(sessionId, pendingToolResults);
      pendingToolResults.length = 0;
    }

    if (signal.aborted) {
      store.appendError(sessionId, "Interrupted by user");
      store.setStatus(sessionId, "idle");
    } else {
      store.setStatus(sessionId, "idle");
    }
  } catch (err) {
    if (signal.aborted) {
      if (pendingToolUses.length > 0) {
        for (const pending of pendingToolUses) {
          pendingToolResults.push({
            type: "tool_result",
            tool_use_id: pending.id,
            content: "[interrupted by user]",
          });
        }
        store.pushUserHistoryBlocks(sessionId, pendingToolResults);
      }
      store.appendError(sessionId, "Interrupted by user");
      store.setStatus(sessionId, "idle");
    } else {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[assistant] error:", message);
      store.appendError(sessionId, message);
      store.setStatus(sessionId, "error", message);
    }
  } finally {
    activeTurnControllers.delete(sessionId);
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

  const controller = new AbortController();
  activeTurnControllers.set(sessionId, controller);

  let transcript = "";
  try {
    transcript = await transcribe(audioPath, controller.signal);
  } catch (err) {
    if (controller.signal.aborted) {
      activeTurnControllers.delete(sessionId);
      store.appendError(sessionId, "Interrupted by user");
      store.setStatus(sessionId, "idle");
      return;
    }

    const msg = err instanceof Error ? err.message : String(err);
    const looksLikeBadAudio =
      msg.includes("Invalid data found when processing input") ||
      msg.includes("EBML header parsing failed") ||
      msg.includes("Failed to load audio");

    activeTurnControllers.delete(sessionId);

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
    activeTurnControllers.delete(sessionId);
    store.setStatus(sessionId, "idle");
    return;
  }

  store.appendUserText(sessionId, transcript);
  await runAssistantTurn(sessionId, controller);
}

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
          const requestedModelId =
            typeof msg.modelId === "string" && msg.modelId.trim()
              ? msg.modelId.trim()
              : modelsConfig.getDefaultModelId();
          if (!modelsConfig.hasModel(requestedModelId)) {
            sendError(conn, `Unknown model: ${requestedModelId}`);
            break;
          }
          const detail = store.createSession(
            requestedModelId,
            modelsConfig.getModelLabel(requestedModelId)
          );
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

        case "message/cancel": {
          const sessionId = conn.selectedSessionId;
          if (!sessionId) {
            sendError(conn, "No session selected.");
            break;
          }
          const ctrl = activeTurnControllers.get(sessionId);
          if (ctrl) ctrl.abort();
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
