import "dotenv/config";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";
import { writeFile, readFile, unlink, mkdir } from "fs/promises";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
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
  "You are a helpful voice assistant. The user is speaking to you via voice transcription. Be concise, warm, and conversational. Keep responses short unless asked for detail.";

type Message = { role: "user" | "assistant"; content: string };

wss.on("connection", (ws) => {
  console.log("Client connected");
  const history: Message[] = [];

  async function handleUserMessage(text: string, userMsgId: string) {
    const userMsg = { role: "user" as const, content: text };
    history.push(userMsg);
    messageStore.set(userMsgId, userMsg);

    const assistantMsgId = randomUUID();
    send(ws, { type: "claude_start", msgId: assistantMsgId });

    const model = process.env.LLM_MODEL || "claude-opus-4-5-20251101";
    const stream = anthropic.messages.stream({
      model,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: history,
    });

    let fullResponse = "";

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        fullResponse += event.delta.text;
        send(ws, { type: "claude_delta", text: event.delta.text });
      }
    }

    const assistantMsg = { role: "assistant" as const, content: fullResponse };
    history.push(assistantMsg);
    messageStore.set(assistantMsgId, assistantMsg);

    send(ws, { type: "claude_done", msgId: assistantMsgId, text: fullResponse });
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
