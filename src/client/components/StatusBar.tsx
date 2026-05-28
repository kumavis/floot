interface Props {
  text: string;
  isError: boolean;
}

export function StatusBar({ text, isError }: Props) {
  return (
    <div className={`status-bar ${isError ? "error" : ""}`}>{text}</div>
  );
}
