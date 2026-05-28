import { EventEmitter } from "events";
import { spawn, type ChildProcess } from "child_process";
import { unlink } from "fs/promises";
import { randomUUID } from "crypto";
import path from "path";
import type { TTSStream, TTSProvider } from "./types.js";
import {
  createSentenceChunkerState,
  flushRemaining,
  pushText,
  type SentenceChunkerState,
} from "./sentence-chunker.js";

export class SayTTSStream extends EventEmitter implements TTSStream {
  private chunker: SentenceChunkerState = createSentenceChunkerState();
  private chunkIndex = 0;
  private processing = false;
  private queue: string[] = [];
  private ended = false;
  private uploadsDir: string;
  private voice: string;
  private aborted = false;
  private doneEmitted = false;
  private activeChildren = new Set<ChildProcess>();

  private emitDoneOnce(): void {
    if (this.doneEmitted) return;
    this.doneEmitted = true;
    this.emit("done");
  }

  constructor(uploadsDir: string, voice: string) {
    super();
    this.uploadsDir = uploadsDir;
    this.voice = voice;
  }

  write(text: string): void {
    if (this.aborted) return;
    this.queue.push(...pushText(this.chunker, text));
    this.processQueue();
  }

  end(): void {
    if (this.aborted) return;
    this.ended = true;
    this.queue.push(...flushRemaining(this.chunker));
    this.processQueue();
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    this.queue = [];
    this.chunker = createSentenceChunkerState();
    for (const child of this.activeChildren) {
      if (!child.killed) child.kill("SIGTERM");
    }
    this.activeChildren.clear();
    this.emitDoneOnce();
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

    if (
      !this.aborted &&
      this.ended &&
      this.queue.length === 0 &&
      !this.chunker.buffer.trim()
    ) {
      this.emitDoneOnce();
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

      if (this.aborted) {
        fail(new Error("Aborted"));
        return;
      }

      const sayProc = spawn("say", ["-v", this.voice, "-o", aiffPath, text]);
      this.activeChildren.add(sayProc);

      sayProc.on("error", fail);
      sayProc.on("close", (code) => {
        this.activeChildren.delete(sayProc);
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
        this.activeChildren.add(ffmpeg);

        ffmpeg.stdout.on("data", (chunk) => chunks.push(chunk));
        ffmpeg.on("error", fail);
        ffmpeg.on("close", (ffmpegCode) => {
          this.activeChildren.delete(ffmpeg);
          if (settled) return;
          if (this.aborted) {
            fail(new Error("Aborted"));
            return;
          }
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
