import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ClientCommand,
  ModelSummary,
  ServerEvent,
  SessionDetail,
  SessionSummary,
} from "../types";

export interface WebSocketState {
  connected: boolean;
  models: ModelSummary[];
  defaultModelId: string;
  sessions: SessionSummary[];
  detail: SessionDetail | null;
  error: string | null;
}

export interface WebSocketApi extends WebSocketState {
  send: (cmd: ClientCommand) => void;
  sendBinary: (blob: Blob) => void;
  clearError: () => void;
}

const RECONNECT_DELAY_MS = 2000;

export function useFlootSocket(): WebSocketApi {
  const [state, setState] = useState<WebSocketState>({
    connected: false,
    models: [],
    defaultModelId: "",
    sessions: [],
    detail: null,
    error: null,
  });

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<number | null>(null);
  const closedByUnmount = useRef(false);

  const connect = useCallback(() => {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${location.host}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setState((s) => ({ ...s, connected: true, error: null }));
    };

    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      let data: ServerEvent;
      try {
        data = JSON.parse(event.data) as ServerEvent;
      } catch {
        return;
      }
      setState((prev) => applyEvent(prev, data));
    };

    ws.onclose = () => {
      setState((s) => ({ ...s, connected: false }));
      if (closedByUnmount.current) return;
      reconnectTimer.current = window.setTimeout(connect, RECONNECT_DELAY_MS);
    };

    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* noop */
      }
    };
  }, []);

  useEffect(() => {
    closedByUnmount.current = false;
    connect();
    return () => {
      closedByUnmount.current = true;
      if (reconnectTimer.current !== null) {
        clearTimeout(reconnectTimer.current);
      }
      const ws = wsRef.current;
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        try {
          ws.close();
        } catch {
          /* noop */
        }
      }
    };
  }, [connect]);

  const send = useCallback((cmd: ClientCommand) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(cmd));
  }, []);

  const sendBinary = useCallback((blob: Blob) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(blob);
  }, []);

  const clearError = useCallback(() => {
    setState((s) => ({ ...s, error: null }));
  }, []);

  return {
    ...state,
    send,
    sendBinary,
    clearError,
  };
}

function applyEvent(prev: WebSocketState, event: ServerEvent): WebSocketState {
  switch (event.type) {
    case "state/init":
      return {
        ...prev,
        models: event.models,
        defaultModelId: event.defaultModelId,
        sessions: event.sessions,
        detail: event.detail,
        error: null,
      };
    case "state/sessions_updated":
      return { ...prev, sessions: event.sessions };
    case "state/session_updated":
      return { ...prev, detail: event.detail };
    case "state/error":
      return { ...prev, error: event.message };
    default:
      return prev;
  }
}
