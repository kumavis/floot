export interface SentenceChunkerState {
  buffer: string;
}

const MIN_CHUNK_LENGTH = 10;

const ABBREVIATIONS = new Set([
  "St",
  "Dr",
  "Mr",
  "Mrs",
  "Ms",
  "Prof",
  "vs",
  "etc",
  "Jr",
  "Sr",
]);

export function createSentenceChunkerState(): SentenceChunkerState {
  return { buffer: "" };
}

function isListMarkerPeriod(text: string, periodIndex: number): boolean {
  const before = text.slice(0, periodIndex);
  const lineStart = before.lastIndexOf("\n") + 1;
  const linePrefix = before.slice(lineStart);
  const listMatch = linePrefix.match(/^(\d+)$/);
  return listMatch !== null;
}

function isAbbreviationPeriod(text: string, periodIndex: number): boolean {
  const before = text.slice(0, periodIndex);
  const wordMatch = before.match(/([A-Za-z]+)$/);
  return wordMatch !== null && ABBREVIATIONS.has(wordMatch[1]);
}

function isSentenceBoundary(text: string, index: number): boolean {
  const char = text[index];
  if (char === "\n") return true;
  if (char === "!" || char === "?") return true;
  if (char === ".") {
    if (isListMarkerPeriod(text, index)) return false;
    if (isAbbreviationPeriod(text, index)) return false;
    return true;
  }
  return false;
}

function flushComplete(state: SentenceChunkerState): string[] {
  const buffer = state.buffer;
  const rawParts: string[] = [];
  let start = 0;

  for (let i = 0; i < buffer.length; i++) {
    if (!isSentenceBoundary(buffer, i)) continue;

    let end = i + 1;
    while (end < buffer.length && /\s/.test(buffer[end])) {
      end++;
    }

    rawParts.push(buffer.slice(start, end));
    start = end;
    i = end - 1;
  }

  const tail = buffer.slice(start);
  const chunks: string[] = [];
  let pending = "";

  for (const part of rawParts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const combined = pending ? `${pending} ${trimmed}` : trimmed;
    if (combined.length >= MIN_CHUNK_LENGTH) {
      chunks.push(combined);
      pending = "";
    } else {
      pending = combined;
    }
  }

  state.buffer = pending ? [pending, tail].filter(Boolean).join(" ") : tail;
  return chunks;
}

/** Push incoming LLM text; return newly flushed speakable chunks. */
export function pushText(
  state: SentenceChunkerState,
  text: string
): string[] {
  state.buffer += text;
  return flushComplete(state);
}

/** Flush any remaining buffered text at text_end. */
export function flushRemaining(state: SentenceChunkerState): string[] {
  const trimmed = state.buffer.trim();
  state.buffer = "";
  return trimmed ? [trimmed] : [];
}
