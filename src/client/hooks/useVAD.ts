import { useCallback, useEffect, useRef, useState } from "react";

const VAD_THRESHOLD = 0.015;
const SILENCE_TIMEOUT_MS = 1500;
const MIN_SPEECH_MS = 400;

export type MicMode = "off" | "listening" | "speaking" | "muted";

export interface VADApi {
  mode: MicMode;
  volume: number;
  error: string | null;
  start: (deviceId?: string) => Promise<void>;
  stop: () => void;
  pause: () => void;
  resume: () => void;
}

interface Options {
  onUtterance: (blob: Blob) => void;
  enabled: boolean;
}

export function useVAD(options: Options): VADApi {
  const [mode, setMode] = useState<MicMode>("off");
  const [volume, setVolume] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const rafRef = useRef<number>(0);
  const speakingRef = useRef(false);
  const silenceStartRef = useRef(0);
  const speechStartRef = useRef(0);
  const activeRef = useRef(false);
  const wasListeningBeforePauseRef = useRef(false);

  const onUtteranceRef = useRef(options.onUtterance);
  onUtteranceRef.current = options.onUtterance;

  const startRecording = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;
    chunksRef.current = [];
    const recorder = new MediaRecorder(stream, {
      mimeType: "audio/webm;codecs=opus",
    });
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.start(100);
    recorderRef.current = recorder;
  }, []);

  const finishRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: "audio/webm" });
      chunksRef.current = [];
      if (blob.size > 0) onUtteranceRef.current?.(blob);
    };
    recorder.stop();
  }, []);

  const cancelRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    recorder.onstop = () => {
      chunksRef.current = [];
    };
    recorder.stop();
  }, []);

  const loop = useCallback(() => {
    if (!activeRef.current) return;
    const analyser = analyserRef.current;
    if (!analyser) return;

    const data = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);

    let rms = 0;
    for (let i = 0; i < data.length; i++) rms += data[i] * data[i];
    rms = Math.sqrt(rms / data.length);

    setVolume(Math.min(rms / 0.1, 1));

    const now = Date.now();
    if (rms > VAD_THRESHOLD) {
      if (!speakingRef.current) {
        speakingRef.current = true;
        speechStartRef.current = now;
        startRecording();
        setMode("speaking");
      }
      silenceStartRef.current = 0;
    } else if (speakingRef.current) {
      if (silenceStartRef.current === 0) {
        silenceStartRef.current = now;
      } else if (now - silenceStartRef.current > SILENCE_TIMEOUT_MS) {
        const duration = now - speechStartRef.current;
        if (duration > MIN_SPEECH_MS) {
          finishRecording();
        } else {
          cancelRecording();
        }
        speakingRef.current = false;
        silenceStartRef.current = 0;
        setMode("listening");
      }
    }

    rafRef.current = requestAnimationFrame(loop);
  }, [cancelRecording, finishRecording, startRecording]);

  const teardown = useCallback(() => {
    activeRef.current = false;
    cancelAnimationFrame(rafRef.current);
    if (speakingRef.current) {
      cancelRecording();
      speakingRef.current = false;
      silenceStartRef.current = 0;
    }
    const stream = streamRef.current;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    const ctx = ctxRef.current;
    if (ctx) {
      ctx.close().catch(() => {});
      ctxRef.current = null;
    }
    analyserRef.current = null;
    recorderRef.current = null;
    setVolume(0);
  }, [cancelRecording]);

  const start = useCallback(
    async (deviceId?: string) => {
      try {
        setError(null);
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: deviceId ? { deviceId: { exact: deviceId } } : true,
        });
        streamRef.current = stream;
        const ctx = new AudioContext();
        ctxRef.current = ctx;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        const source = ctx.createMediaStreamSource(stream);
        source.connect(analyser);
        analyserRef.current = analyser;
        activeRef.current = true;
        speakingRef.current = false;
        setMode("listening");
        rafRef.current = requestAnimationFrame(loop);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(`Mic access denied: ${message}`);
        setMode("off");
        teardown();
      }
    },
    [loop, teardown]
  );

  const stop = useCallback(() => {
    if (speakingRef.current) finishRecording();
    teardown();
    setMode("off");
  }, [finishRecording, teardown]);

  const pause = useCallback(() => {
    if (!activeRef.current) return;
    wasListeningBeforePauseRef.current = true;
    activeRef.current = false;
    cancelAnimationFrame(rafRef.current);
    if (speakingRef.current) {
      cancelRecording();
      speakingRef.current = false;
      silenceStartRef.current = 0;
    }
    setVolume(0);
    setMode("muted");
  }, [cancelRecording]);

  const resume = useCallback(() => {
    if (!streamRef.current || !analyserRef.current) return;
    if (!wasListeningBeforePauseRef.current) return;
    wasListeningBeforePauseRef.current = false;
    activeRef.current = true;
    speakingRef.current = false;
    setMode("listening");
    rafRef.current = requestAnimationFrame(loop);
  }, [loop]);

  useEffect(() => {
    if (!options.enabled && mode !== "off") {
      teardown();
      setMode("off");
    }
  }, [mode, options.enabled, teardown]);

  useEffect(() => {
    return () => {
      teardown();
    };
  }, [teardown]);

  return { mode, volume, error, start, stop, pause, resume };
}
