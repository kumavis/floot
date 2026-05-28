import { useEffect, useRef, useState } from "react";
import type { MicMode } from "../hooks/useVAD";
import { MicIcon, SendIcon } from "./icons";

interface Props {
  disabled: boolean;
  micDisabled: boolean;
  micMode: MicMode;
  onSendText: (text: string) => void;
  onToggleMic: () => void;
}

export function InputBar({
  disabled,
  micDisabled,
  micMode,
  onSendText,
  onToggleMic,
}: Props) {
  const [text, setText] = useState("");
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const ta = textRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
  }, [text]);

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSendText(trimmed);
    setText("");
  };

  const micClass = (() => {
    switch (micMode) {
      case "listening":
        return "listening";
      case "speaking":
        return "speaking";
      case "muted":
        return "muted";
      default:
        return "";
    }
  })();

  return (
    <div className="input-bar">
      <textarea
        ref={textRef}
        className="text-input"
        rows={1}
        placeholder="Type a message..."
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <button
        type="button"
        className={`btn mic-btn ${micClass}`}
        title="Toggle microphone"
        disabled={micDisabled}
        onClick={onToggleMic}
      >
        <MicIcon />
      </button>
      <button
        type="button"
        className="btn send-btn"
        title="Send message"
        disabled={disabled || !text.trim()}
        onClick={submit}
      >
        <SendIcon />
      </button>
    </div>
  );
}
