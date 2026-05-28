import type { SessionSummary } from "../types";
import { PlusIcon, TrashIcon } from "./icons";

interface Props {
  sessions: SessionSummary[];
  activeId: string | null;
  onCreate: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

export function Sidebar({
  sessions,
  activeId,
  onCreate,
  onSelect,
  onDelete,
}: Props) {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">Sessions</span>
        <button
          type="button"
          className="new-session-btn"
          onClick={onCreate}
          title="New session"
        >
          <PlusIcon />
          New
        </button>
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
              <span className="session-title">{s.title || "Untitled"}</span>
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
