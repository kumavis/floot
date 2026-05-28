import { EventEmitter } from "events";
import { randomUUID } from "crypto";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

export type SessionStatus = "idle" | "transcribing" | "streaming" | "error";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export type UiMessageKind =
  | "user_text"
  | "assistant_text"
  | "tool_call"
  | "tool_result"
  | "error"
  | "end_reason";

export interface UiMessage {
  id: string;
  kind: UiMessageKind;
  text: string;
  toolName?: string;
  createdAt: number;
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

interface SessionRecord {
  id: string;
  title: string;
  status: SessionStatus;
  lastError: string | null;
  modelId: string;
  modelLabel: string;
  providerSessionId: string | null;
  createdAt: number;
  updatedAt: number;
  history: ChatMessage[];
  uiMessages: UiMessage[];
}

const DEFAULT_TITLE = "New chat";

export class SessionStore extends EventEmitter {
  private sessions = new Map<string, SessionRecord>();

  createSession(modelId: string, modelLabel: string): SessionDetail {
    const now = Date.now();
    const record: SessionRecord = {
      id: randomUUID(),
      title: DEFAULT_TITLE,
      status: "idle",
      lastError: null,
      modelId,
      modelLabel,
      providerSessionId: null,
      createdAt: now,
      updatedAt: now,
      history: [],
      uiMessages: [],
    };
    this.sessions.set(record.id, record);
    this.emit("sessionsUpdated");
    return this.detailOf(record);
  }

  deleteSession(id: string): boolean {
    if (!this.sessions.has(id)) return false;
    this.sessions.delete(id);
    this.emit("sessionDeleted", id);
    this.emit("sessionsUpdated");
    return true;
  }

  hasSession(id: string): boolean {
    return this.sessions.has(id);
  }

  listSummaries(): SessionSummary[] {
    return [...this.sessions.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((s) => this.summaryOf(s));
  }

  getDetail(id: string): SessionDetail | undefined {
    const record = this.sessions.get(id);
    if (!record) return undefined;
    return this.detailOf(record);
  }

  getHistory(id: string): ChatMessage[] | undefined {
    return this.sessions.get(id)?.history;
  }

  getModelId(id: string): string | undefined {
    return this.sessions.get(id)?.modelId;
  }

  getProviderSessionId(id: string): string | undefined {
    return this.sessions.get(id)?.providerSessionId ?? undefined;
  }

  setProviderSessionId(id: string, providerSessionId: string): void {
    const record = this.sessions.get(id);
    if (!record) return;
    record.providerSessionId = providerSessionId;
    this.touch(record);
  }

  getLatestUserMessage(id: string): string | undefined {
    const record = this.sessions.get(id);
    if (!record) return undefined;
    for (let i = record.history.length - 1; i >= 0; i--) {
      const message = record.history[i];
      if (message.role !== "user") continue;
      if (typeof message.content === "string") {
        return message.content;
      }
      const textBlock = message.content.find((block) => block.type === "text");
      if (textBlock && textBlock.type === "text") {
        return textBlock.text;
      }
    }
    return undefined;
  }

  setStatus(
    id: string,
    status: SessionStatus,
    lastError: string | null = null
  ): void {
    const record = this.sessions.get(id);
    if (!record) return;
    record.status = status;
    record.lastError = lastError;
    this.touch(record);
    this.emit("sessionUpdated", id);
    this.emit("sessionsUpdated");
  }

  appendUserText(id: string, text: string): UiMessage | undefined {
    const record = this.sessions.get(id);
    if (!record) return undefined;
    const msg: UiMessage = {
      id: randomUUID(),
      kind: "user_text",
      text,
      createdAt: Date.now(),
    };
    record.uiMessages.push(msg);
    record.history.push({ role: "user", content: text });

    if (record.title === DEFAULT_TITLE) {
      const derived = text.trim().slice(0, 60);
      if (derived) record.title = derived;
    }

    this.touch(record);
    this.emit("sessionUpdated", id);
    this.emit("sessionsUpdated");
    return msg;
  }

  beginAssistantText(id: string): UiMessage | undefined {
    const record = this.sessions.get(id);
    if (!record) return undefined;
    const msg: UiMessage = {
      id: randomUUID(),
      kind: "assistant_text",
      text: "",
      createdAt: Date.now(),
    };
    record.uiMessages.push(msg);
    this.touch(record);
    this.emit("sessionUpdated", id);
    return msg;
  }

  appendAssistantDelta(id: string, msgId: string, delta: string): void {
    const record = this.sessions.get(id);
    if (!record) return;
    const msg = record.uiMessages.find((m) => m.id === msgId);
    if (!msg || msg.kind !== "assistant_text") return;
    msg.text += delta;
    this.touch(record);
    this.emit("sessionUpdated", id);
  }

  pushAssistantHistoryBlocks(id: string, blocks: ContentBlock[]): void {
    const record = this.sessions.get(id);
    if (!record) return;
    record.history.push({ role: "assistant", content: blocks });
    this.touch(record);
  }

  pushUserHistoryBlocks(id: string, blocks: ContentBlock[]): void {
    const record = this.sessions.get(id);
    if (!record) return;
    record.history.push({ role: "user", content: blocks });
    this.touch(record);
  }

  appendToolCall(
    id: string,
    toolName: string,
    input: unknown
  ): UiMessage | undefined {
    const record = this.sessions.get(id);
    if (!record) return undefined;
    const text =
      typeof input === "string" ? input : JSON.stringify(input, null, 2);
    const msg: UiMessage = {
      id: randomUUID(),
      kind: "tool_call",
      toolName,
      text,
      createdAt: Date.now(),
    };
    record.uiMessages.push(msg);
    this.touch(record);
    this.emit("sessionUpdated", id);
    return msg;
  }

  appendToolResult(
    id: string,
    toolName: string,
    result: string
  ): UiMessage | undefined {
    const record = this.sessions.get(id);
    if (!record) return undefined;
    const truncated =
      result.length > 500 ? result.slice(0, 500) + "\u2026" : result;
    const msg: UiMessage = {
      id: randomUUID(),
      kind: "tool_result",
      toolName,
      text: truncated,
      createdAt: Date.now(),
    };
    record.uiMessages.push(msg);
    this.touch(record);
    this.emit("sessionUpdated", id);
    return msg;
  }

  appendEndReason(id: string, text: string): UiMessage | undefined {
    const record = this.sessions.get(id);
    if (!record) return undefined;
    const msg: UiMessage = {
      id: randomUUID(),
      kind: "end_reason",
      text,
      createdAt: Date.now(),
    };
    record.uiMessages.push(msg);
    this.touch(record);
    this.emit("sessionUpdated", id);
    return msg;
  }

  appendError(id: string, message: string): UiMessage | undefined {
    const record = this.sessions.get(id);
    if (!record) return undefined;
    const msg: UiMessage = {
      id: randomUUID(),
      kind: "error",
      text: message,
      createdAt: Date.now(),
    };
    record.uiMessages.push(msg);
    record.lastError = message;
    this.touch(record);
    this.emit("sessionUpdated", id);
    return msg;
  }

  getAssistantTextById(
    uiMsgId: string
  ): { sessionId: string; text: string } | undefined {
    for (const record of this.sessions.values()) {
      const msg = record.uiMessages.find((m) => m.id === uiMsgId);
      if (msg && msg.kind === "assistant_text" && msg.text.trim()) {
        return { sessionId: record.id, text: msg.text };
      }
    }
    return undefined;
  }

  private touch(record: SessionRecord): void {
    record.updatedAt = Date.now();
  }

  private summaryOf(record: SessionRecord): SessionSummary {
    return {
      id: record.id,
      title: record.title,
      status: record.status,
      modelId: record.modelId,
      modelLabel: record.modelLabel,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private detailOf(record: SessionRecord): SessionDetail {
    return {
      ...this.summaryOf(record),
      lastError: record.lastError,
      messages: record.uiMessages.map((m) => ({ ...m })),
    };
  }
}
