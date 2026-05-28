import { EventEmitter } from "events";
import { spawn } from "child_process";
import { unlink } from "fs/promises";
import { randomUUID } from "crypto";
import path from "path";
import type { TTSStream, TTSProvider } from "./types.js";

// Split on sentence boundaries - periods, question marks, exclamation points, newlines
const SENTENCE_ENDINGS = /(?<=[.!?\n])\s*/;
const MIN_CHUNK_LENGTH = 10; // Don't send tiny fragments

export class SayTTSStream extends EventEmitter implements TTSStream {
  private buffer = "";
  private chunkIndex = 0;
  private processing = false;
  private queue: string[] = [];
  private ended = false;
  private uploadsDir: string;
  private voice: string;
  private aborted = false;

  constructor(uploadsDir: string, voice: string) {
    super();
    this.uploadsDir = uploadsDir;
    this.voice = voice;
  }

  write(text: string): void {
    if (this.aborted) return;
    this.buffer += text;
    this.tryFlushSentences();
  }

  end(): void {
    if (this.aborted) return;
    this.ended = true;
    // Flush any remaining text
    if (this.buffer.trim()) {
      this.queue.push(this.buffer.trim());
      this.buffer = "";
    }
    this.processQueue();
  }

  abort(): void {
    this.aborted = true;
    this.queue = [];
    this.buffer = "";
    this.emit("done");
  }

  private tryFlushSentences(): void {
    // Split on sentence boundaries
    const parts = this.buffer.split(SENTENCE_ENDINGS);
    
    // Keep the last part in buffer (might be incomplete)
    this.buffer = parts.pop() || "";
    
    // Queue complete sentences
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed.length >= MIN_CHUNK_LENGTH) {
        this.queue.push(trimmed);
      } else if (trimmed) {
        // Too short, prepend to buffer
        this.buffer = trimmed + " " + this.buffer;
      }
    }
    
    this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.aborted) return;
    this.processing = true;

    while (this.queue.length > 0 && !this.aborted) {
      const text = this.queue.shift()!;
      try {
        const audio = await this.synthesize(text);
        if (!this.aborted) {
          this.emit("audio", audio, this.chunkIndex++);
        }
      } catch (err) {
        if (!this.aborted) {
          this.emit("error", err instanceof Error ? err : new Error(String(err)));
        }
      }
    }

    this.processing = false;
    
    if (!this.aborted && this.ended && this.queue.length === 0 && !this.buffer.trim()) {
      this.emit("done");
    }
  }

  private async synthesize(text: string): Promise<Buffer> {
    const id = randomUUID();
    const aiffPath = path.join(this.uploadsDir, `${id}.aiff`);
    const cleanup = () => {
      unlink(aiffPath).catch(() => {});
    };

    return new Promise((resolve, reject) => {
      // Guard against duplicate settlement when both `error` and `close`
      // events fire on the same process. Every failure path goes through
      // `fail()` so the temp AIFF is always removed.
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };
      const succeed = (buf: Buffer) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(buf);
      };

      const sayProc = spawn("say", ["-v", this.voice, "-o", aiffPath, text]);

      sayProc.on("error", fail);
      sayProc.on("close", (code) => {
        if (settled) return;

        if (this.aborted) {
          fail(new Error("Aborted"));
          return;
        }

        if (code !== 0) {
          fail(new Error(`say exited with code ${code}`));
          return;
        }

        const chunks: Buffer[] = [];
        const ffmpeg = spawn(
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
          { stdio: ["ignore", "pipe", "ignore"] }
        );

        ffmpeg.stdout.on("data", (chunk) => chunks.push(chunk));
        ffmpeg.on("error", fail);
        ffmpeg.on("close", (ffmpegCode) => {
          if (settled) return;
          if (ffmpegCode === 0) {
            succeed(Buffer.concat(chunks));
          } else {
            fail(new Error(`ffmpeg exited with code ${ffmpegCode}`));
          }
        });
      });
    });
  }
}

export class SayTTSProvider implements TTSProvider {
  private uploadsDir: string;
  private voice: string;

  constructor(uploadsDir: string, voice: string = "Fiona (Enhanced)") {
    this.uploadsDir = uploadsDir;
    this.voice = voice;
  }

  createStream(): SayTTSStream {
    return new SayTTSStream(this.uploadsDir, this.voice);
  }
}
