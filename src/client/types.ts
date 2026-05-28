export type SessionStatus = "idle" | "transcribing" | "streaming" | "error";

export type UiMessageKind =
  | "user_text"
  | "assistant_text"
  | "tool_call"
  | "tool_result"
  | "error";

export interface UiMessage {
  id: string;
  kind: UiMessageKind;
  text: string;
  toolName?: string;
  createdAt: number;
}

export interface ModelSummary {
  id: string;
  label: string;
  provider: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  status: SessionStatus;
  modelId: string;
  modelLabel: string;
  createdAt: number;
  updatedAt: number;
}

export interface SessionDetail extends SessionSummary {
  messages: UiMessage[];
  lastError: string | null;
}

export type ServerEvent =
  | {
      type: "state/init";
      models: ModelSummary[];
      defaultModelId: string;
      sessions: SessionSummary[];
      detail: SessionDetail | null;
    }
  | { type: "state/sessions_updated"; sessions: SessionSummary[] }
  | { type: "state/session_updated"; detail: SessionDetail | null }
  | { type: "state/error"; message: string };

export type ClientCommand =
  | { type: "session/list" }
  | { type: "session/create"; modelId?: string }
  | { type: "session/select"; sessionId: string }
  | { type: "session/delete"; sessionId: string }
  | { type: "message/send_text"; content: string }
  | { type: "message/cancel" };
