import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatView } from "./components/ChatView";
import { InputBar } from "./components/InputBar";
import { MicSelect } from "./components/MicSelect";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { useFlootSocket } from "./hooks/useWebSocket";
import { useTTS } from "./hooks/useTTS";
import { useVAD } from "./hooks/useVAD";
import type { SessionDetail } from "./types";

export function App() {
  const {
    connected,
    models,
    defaultModelId,
    sessions,
    detail,
    error,
    send,
    sendBinary,
    clearError,
  } = useFlootSocket();

  const [deviceId, setDeviceId] = useState<string>("");
  const autoplayedRef = useRef<Set<string>>(new Set());
  const prevSessionIdRef = useRef<string | null>(null);

  const tts = useTTS({
    onPlaybackStart: () => {
      vad.pause();
    },
    onPlaybackEnd: () => {
      vad.resume();
    },
  });

  const handleUtterance = useCallback(
    (blob: Blob) => {
      if (!detail) return;
      sendBinary(blob);
    },
    [detail, sendBinary]
  );

  const detailRef = useRef(detail);
  detailRef.current = detail;

  const handleBargeIn = useCallback(() => {
    tts.stop();
    const status = detailRef.current?.status;
    if (status === "streaming" || status === "transcribing") {
      send({ type: "message/cancel" });
    }
  }, [send, tts]);

  const vad = useVAD({
    enabled: detail !== null,
    onUtterance: handleUtterance,
    onBargeIn: handleBargeIn,
  });

  const isStreaming =
    detail?.status === "streaming" || detail?.status === "transcribing";

  const statusText = useMemo(() => {
    if (error) return error;
    if (!connected) return "Disconnected. Reconnecting...";
    if (!detail) return "";
    switch (detail.status) {
      case "transcribing":
        return "Transcribing audio...";
      case "streaming":
        return "Assistant is responding...";
      case "error":
        return detail.lastError || "Something went wrong.";
      default:
        return "";
    }
  }, [connected, detail, error]);

  const isError = error !== null || detail?.status === "error";

  // Reset autoplay memory when switching sessions
  useEffect(() => {
    const currentId = detail?.id ?? null;
    if (prevSessionIdRef.current !== currentId) {
      prevSessionIdRef.current = currentId;
      autoplayedRef.current = new Set();
      tts.stop();
    }
  }, [detail?.id, tts]);

  // Autoplay assistant message as soon as it appears (while streaming)
  // This enables true streaming TTS - audio starts before response is complete
  useEffect(() => {
    if (!detail) return;
    
    // Find the latest assistant text message
    const latest = findLatestAssistantText(detail);
    if (!latest) return;
    
    // Don't autoplay if we've already started playing this message
    if (autoplayedRef.current.has(latest.id)) return;
    
    // Start playing as soon as we see a new assistant message
    // (even while status is still "streaming")
    autoplayedRef.current.add(latest.id);
    void tts.play(latest.id);
  }, [detail, tts]);

  // Clear transient WS error after a short delay
  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(clearError, 4000);
    return () => clearTimeout(timer);
  }, [error, clearError]);

  const handleCreate = useCallback(
    (modelId: string) => {
      send({ type: "session/create", modelId });
    },
    [send]
  );

  const handleSelect = useCallback(
    (id: string) => {
      if (detail?.id === id) return;
      send({ type: "session/select", sessionId: id });
    },
    [detail?.id, send]
  );

  const handleDelete = useCallback(
    (id: string) => {
      send({ type: "session/delete", sessionId: id });
    },
    [send]
  );

  const handleSendText = useCallback(
    (text: string) => {
      send({ type: "message/send_text", content: text });
    },
    [send]
  );

  const handleCancel = useCallback(() => {
    tts.stop();
    send({ type: "message/cancel" });
  }, [send, tts]);

  const handleToggleMic = useCallback(() => {
    if (tts.playingMessageId) {
      tts.stop();
      return;
    }
    if (!detail) return;
    if (vad.mode === "off") {
      void vad.start(deviceId || undefined);
    } else {
      vad.stop();
    }
  }, [detail, deviceId, tts, vad]);

  const handlePlay = useCallback(
    (messageId: string) => {
      void tts.play(messageId);
    },
    [tts]
  );

  const handleStopPlay = useCallback(() => {
    tts.stop();
  }, [tts]);

  return (
    <div className="app">
      <Sidebar
        sessions={sessions}
        models={models}
        defaultModelId={defaultModelId}
        activeId={detail?.id ?? null}
        onCreate={handleCreate}
        onSelect={handleSelect}
        onDelete={handleDelete}
      />
      <main className="main">
        <div className="header">
          <div className="header-meta">
            <span className={`header-title ${!detail ? "empty" : ""}`}>
              {detail?.title || "Floot"}
            </span>
            {detail ? (
              <span className="header-model">{detail.modelLabel}</span>
            ) : null}
          </div>
          <div className="header-controls">
            <MicSelect value={deviceId} onChange={setDeviceId} />
          </div>
        </div>

        <ChatView
          detail={detail}
          playingMessageId={tts.playingMessageId}
          onPlay={handlePlay}
          onStop={handleStopPlay}
        />

        <div className="volume-bar">
          <div
            className="volume-bar-fill"
            style={{ width: `${vad.volume * 100}%` }}
          />
        </div>

        <StatusBar text={statusText} isError={isError} />

        <InputBar
          disabled={!detail || isStreaming}
          micDisabled={!detail}
          micMode={vad.mode}
          canCancel={
            detail?.status === "streaming" || detail?.status === "transcribing"
          }
          onSendText={handleSendText}
          onToggleMic={handleToggleMic}
          onCancel={handleCancel}
        />
      </main>
    </div>
  );
}

function findLatestAssistantText(detail: SessionDetail) {
  const messages = detail.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.kind === "assistant_text" && msg.text.trim()) {
      return msg;
    }
    if (msg.kind === "user_text") return null;
  }
  return null;
}
