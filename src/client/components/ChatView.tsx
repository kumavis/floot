import { useEffect, useRef } from "react";
import type { SessionDetail } from "../types";
import {
  AssistantBubble,
  EndReasonBadge,
  ErrorBubble,
  UserBubble,
} from "./MessageBubble";
import { ToolBlock } from "./ToolBlock";

interface Props {
  detail: SessionDetail | null;
  playingMessageId: string | null;
  onPlay: (messageId: string) => void;
  onStop: () => void;
}

export function ChatView({ detail, playingMessageId, onPlay, onStop }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const prevSessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const sessionChanged = prevSessionIdRef.current !== (detail?.id ?? null);
    prevSessionIdRef.current = detail?.id ?? null;

    const nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (sessionChanged || nearBottom) {
      el.scrollTop = el.scrollHeight;
    }
  });

  if (!detail) {
    return (
      <div className="messages" ref={containerRef}>
        <div className="empty-state">
          No session selected.
          <div className="hint">
            Create a new session from the sidebar to start chatting.
          </div>
        </div>
      </div>
    );
  }

  const messages = detail.messages;
  const lastMsg = messages[messages.length - 1];
  const showThinking =
    detail.status === "streaming" &&
    lastMsg !== undefined &&
    lastMsg.kind !== "assistant_text";
  return (
    <div className="messages" ref={containerRef}>
      {messages.map((msg, idx) => {
        const isLast = idx === messages.length - 1;
        switch (msg.kind) {
          case "user_text":
            return <UserBubble key={msg.id} text={msg.text} />;
          case "assistant_text":
            return (
              <AssistantBubble
                key={msg.id}
                id={msg.id}
                text={msg.text}
                isStreaming={isLast && detail.status === "streaming"}
                isPlaying={playingMessageId === msg.id}
                onPlay={() => onPlay(msg.id)}
                onStop={onStop}
              />
            );
          case "tool_call":
            return (
              <ToolBlock
                key={msg.id}
                toolName={msg.toolName}
                content={msg.text}
                isResult={false}
              />
            );
          case "tool_result":
            return (
              <ToolBlock
                key={msg.id}
                toolName={msg.toolName}
                content={msg.text}
                isResult={true}
              />
            );
          case "error":
            return <ErrorBubble key={msg.id} text={msg.text} />;
          case "end_reason":
            return <EndReasonBadge key={msg.id} text={msg.text} />;
          default:
            return null;
        }
      })}
      {showThinking && (
        <div className="thinking">
          <span className="thinking-dot" />
          <span className="thinking-dot" />
          <span className="thinking-dot" />
        </div>
      )}
    </div>
  );
}
