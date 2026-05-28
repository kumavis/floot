import { EventEmitter } from "events";

export interface TTSEvents {
  audio: (chunk: Buffer, index: number) => void;
  error: (error: Error) => void;
  done: () => void;
}

export interface TTSStream extends EventEmitter {
  on<K extends keyof TTSEvents>(event: K, listener: TTSEvents[K]): this;
  emit<K extends keyof TTSEvents>(event: K, ...args: Parameters<TTSEvents[K]>): boolean;
  
  /** Push text into the TTS stream */
  write(text: string): void;
  
  /** Signal that no more text is coming */
  end(): void;
  
  /** Abort the stream (stop processing) */
  abort(): void;
}

export interface TTSProvider {
  /** Create a new TTS stream for converting text to audio */
  createStream(): TTSStream;
}
