import { useEffect, useState } from "react";
import type { ModelSummary, SessionSummary } from "../types";
import { PlusIcon, TrashIcon } from "./icons";

interface Props {
  sessions: SessionSummary[];
  models: ModelSummary[];
  defaultModelId: string;
  activeId: string | null;
  onCreate: (modelId: string) => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

export function Sidebar({
  sessions,
  models,
  defaultModelId,
  activeId,
  onCreate,
  onSelect,
  onDelete,
}: Props) {
  const [selectedModelId, setSelectedModelId] = useState(defaultModelId);

  useEffect(() => {
    const firstModelId = models[0]?.id ?? defaultModelId;
    if (firstModelId) {
      setSelectedModelId(firstModelId);
    }
  }, [defaultModelId, models]);

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">Sessions</span>
        <div className="sidebar-actions">
          {models.length > 0 ? (
            <select
              className="model-select"
              value={selectedModelId}
              onChange={(event) => setSelectedModelId(event.target.value)}
            >
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
          ) : null}
          <button
            type="button"
            className="new-session-btn"
            onClick={() => onCreate(selectedModelId || models[0]?.id || "")}
            title="New session"
            disabled={models.length === 0}
          >
            <PlusIcon />
            New
          </button>
        </div>
      </div>
      <div className="session-list">
        {sessions.length === 0 ? (
          <div className="session-empty">No sessions yet</div>
        ) : (
          sessions.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`session-item ${s.id === activeId ? "active" : ""}`}
              onClick={() => onSelect(s.id)}
            >
              <span
                className={`session-status-dot ${
                  s.status !== "idle" ? s.status : ""
                }`}
              />
              <span className="session-item-body">
                <span className="session-title">{s.title || "Untitled"}</span>
                <span className="session-model">{s.modelLabel}</span>
              </span>
              <button
                type="button"
                className="session-delete-btn"
                title="Delete session"
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`Delete session "${s.title || "Untitled"}"?`)) {
                    onDelete(s.id);
                  }
                }}
              >
                <TrashIcon />
              </button>
            </button>
          ))
        )}
      </div>
    </aside>
  );
}
