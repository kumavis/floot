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
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playTokenRef = useRef(0);
  const [playingMessageId, setPlayingMessageId] = useState<string | null>(null);

  const optsRef = useRef(options);
  optsRef.current = options;

  const stop = useCallback(() => {
    playTokenRef.current++;
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.src = "";
      audio.load();
    }
    setPlayingMessageId(null);
    optsRef.current.onPlaybackEnd?.();
  }, []);

  const play = useCallback(
    async (messageId: string) => {
      // Stop any current playback
      const currentAudio = audioRef.current;
      if (currentAudio) {
        currentAudio.pause();
        currentAudio.src = "";
      }

      const myToken = ++playTokenRef.current;
      const isCancelled = () => playTokenRef.current !== myToken;

      // Mark as playing immediately for UI feedback
      setPlayingMessageId(messageId);
      optsRef.current.onPlaybackStart?.();

      try {
        // Create a new audio element
        const audio = new Audio();
        audioRef.current = audio;

        // Set up event handlers before setting src
        const playPromise = new Promise<void>((resolve, reject) => {
          audio.onended = () => {
            if (isCancelled()) return;
            setPlayingMessageId(null);
            optsRef.current.onPlaybackEnd?.();
            resolve();
          };

          audio.onerror = () => {
            if (isCancelled()) return;
            const error = audio.error;
            reject(new Error(`Audio error: ${error?.message || "unknown"}`));
          };

          // This fires when enough data is buffered to start playing
          audio.oncanplay = () => {
            if (isCancelled()) return;
            audio.play().catch(reject);
          };
        });

        // Set the streaming URL - the browser will start fetching and playing
        // as soon as it has enough data buffered
        audio.src = `/api/tts/${messageId}`;
        audio.load();

        await playPromise;
      } catch (err) {
        if (isCancelled()) return;
        console.error("TTS playback error:", err);
        setPlayingMessageId(null);
        optsRef.current.onPlaybackEnd?.();
      }
    },
    []
  );

  useEffect(() => {
    return () => {
      playTokenRef.current++;
      const audio = audioRef.current;
      if (audio) {
        audio.pause();
        audio.src = "";
      }
    };
  }, []);

  return { playingMessageId, play, stop };
}
