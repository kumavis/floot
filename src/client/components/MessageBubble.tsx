import { PlayIcon, StopIcon } from "./icons";

interface UserBubbleProps {
  text: string;
}

export function UserBubble({ text }: UserBubbleProps) {
  return (
    <div className="msg-row user">
      <div className="msg">{text}</div>
    </div>
  );
}

interface AssistantBubbleProps {
  id: string;
  text: string;
  isStreaming: boolean;
  isPlaying: boolean;
  onPlay: () => void;
  onStop: () => void;
}

export function AssistantBubble({
  text,
  isStreaming,
  isPlaying,
  onPlay,
  onStop,
}: AssistantBubbleProps) {
  return (
    <div className={`msg-row assistant ${isStreaming ? "streaming" : ""}`}>
      <div className={`msg ${isPlaying ? "playing" : ""}`}>{text}</div>
      {!isStreaming && text.trim() && (
        <button
          type="button"
          className={`play-btn ${isPlaying ? "playing" : ""}`}
          onClick={isPlaying ? onStop : onPlay}
        >
          {isPlaying ? <StopIcon /> : <PlayIcon />}
          {isPlaying ? "Playing" : "Play"}
        </button>
      )}
    </div>
  );
}

interface ErrorBubbleProps {
  text: string;
}

export function ErrorBubble({ text }: ErrorBubbleProps) {
  return (
    <div className="msg-row error">
      <div className="msg">{text}</div>
    </div>
  );
}

interface EndReasonProps {
  text: string;
}

export function EndReasonBadge({ text }: EndReasonProps) {
  const variant =
    text.startsWith("Ended unexpectedly")
      ? "error"
      : text === "Interrupted by user"
      ? "interrupted"
      : text.startsWith("Stopped")
      ? "stopped"
      : "ok";
  return (
    <div className={`end-reason end-reason-${variant}`}>
      <span className="end-reason-dot" />
      {text}
    </div>
  );
}
