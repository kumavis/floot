interface Props {
  toolName?: string;
  content: string;
  isResult: boolean;
}

export function ToolBlock({ toolName, content, isResult }: Props) {
  return (
    <div className={`tool-block ${isResult ? "result" : ""}`}>
      <div className="tool-label">
        {(toolName || "tool") + (isResult ? " result" : "")}
      </div>
      <pre>{content}</pre>
    </div>
  );
}
