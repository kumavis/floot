import { useCallback, useEffect, useRef, useState } from "react";

export interface TTSApi {
  playingMessageId: string | null;
  play: (messageId: string) => Promise<void>;
  stop: () => void;
}

interface Options {
  onPlaybackStart?: () => void;
  onPlaybackEnd?: () => void;
}

export function useTTS(options: Options = {}): TTSApi {
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const isPlayingRef = useRef(false);
  // Monotonic token: every stop()/play() bumps this so any in-flight
  // play() awaits that resume later can detect they've been superseded
  // and bail out before starting a (now duplicate) audio source.
  const playTokenRef = useRef(0);
  const [playingMessageId, setPlayingMessageId] = useState<string | null>(null);

  const optsRef = useRef(options);
  optsRef.current = options;

  const getCtx = useCallback(() => {
    let ctx = audioCtxRef.current;
    if (!ctx || ctx.state === "closed") {
      ctx = new AudioContext();
      audioCtxRef.current = ctx;
    }
    return ctx;
  }, []);

  const stopActiveSource = useCallback(() => {
    const src = sourceRef.current;
    if (!src) return;
    src.onended = null;
    try {
      src.stop();
    } catch {
      /* already stopped */
    }
    try {
      src.disconnect();
    } catch {
      /* noop */
    }
    sourceRef.current = null;
  }, []);

  const stop = useCallback(() => {
    playTokenRef.current++;
    stopActiveSource();
    if (isPlayingRef.current) {
      isPlayingRef.current = false;
      setPlayingMessageId(null);
      optsRef.current.onPlaybackEnd?.();
    }
  }, [stopActiveSource]);

  const play = useCallback(
    async (messageId: string) => {
      // Internal teardown of any active source without flipping the
      // "playing" state — we're about to replace it.
      playTokenRef.current++;
      stopActiveSource();

      const myToken = ++playTokenRef.current;
      const isCancelled = () => playTokenRef.current !== myToken;

      // Optimistic UI: mark as playing immediately so the bubble shows
      // the green outline / Stop affordance before audio is ready.
      const wasPlaying = isPlayingRef.current;
      isPlayingRef.current = true;
      setPlayingMessageId(messageId);
      if (!wasPlaying) {
        optsRef.current.onPlaybackStart?.();
      }

      try {
        const resp = await fetch(`/api/tts/${messageId}`);
        if (isCancelled()) return;
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

        const buffer = await resp.arrayBuffer();
        if (isCancelled()) return;

        const ctx = getCtx();
        if (ctx.state === "suspended") await ctx.resume();
        if (isCancelled()) return;

        const audioBuf = await ctx.decodeAudioData(buffer);
        if (isCancelled()) return;

        // Final guard: if anything else grabbed the audio output, stop it first.
        stopActiveSource();

        const src = ctx.createBufferSource();
        src.buffer = audioBuf;
        src.connect(ctx.destination);
        sourceRef.current = src;

        src.onended = () => {
          if (sourceRef.current !== src) return;
          sourceRef.current = null;
          isPlayingRef.current = false;
          setPlayingMessageId(null);
          optsRef.current.onPlaybackEnd?.();
        };

        src.start(0);
      } catch (err) {
        if (isCancelled()) return;
        console.error("TTS playback error:", err);
        isPlayingRef.current = false;
        setPlayingMessageId(null);
        optsRef.current.onPlaybackEnd?.();
      }
    },
    [getCtx, stopActiveSource]
  );

  useEffect(() => {
    return () => {
      playTokenRef.current++;
      stopActiveSource();
      isPlayingRef.current = false;
    };
  }, [stopActiveSource]);

  return { playingMessageId, play, stop };
}
