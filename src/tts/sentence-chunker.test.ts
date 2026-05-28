import { describe, expect, it } from "vitest";
import {
  createSentenceChunkerState,
  flushRemaining,
  pushText,
} from "./sentence-chunker.js";

const PRAGUE_RESPONSE = `It seems like the "google" command isn't available on your system. I'll provide you with some general information about top things to do in Prague:

1. Visit Charles Bridge for its beautiful architecture and street performers.
2. Explore the historic Old Town Square, including the famous Astronomical Clock.
3. Walk through Petřín Tower for panoramic views of the city.
4. Discover the stunning St. Vitus Cathedral within Prague Castle.
5. Take a stroll along the Vltava River and enjoy the city's scenic beauty.

Would you like more specific information or help with something else?`;

const EXPECTED_CHUNKS = [
  `It seems like the "google" command isn't available on your system.`,
  `I'll provide you with some general information about top things to do in Prague:`,
  `1. Visit Charles Bridge for its beautiful architecture and street performers.`,
  `2. Explore the historic Old Town Square, including the famous Astronomical Clock.`,
  `3. Walk through Petřín Tower for panoramic views of the city.`,
  `4. Discover the stunning St. Vitus Cathedral within Prague Castle.`,
  `5. Take a stroll along the Vltava River and enjoy the city's scenic beauty.`,
  `Would you like more specific information or help with something else?`,
];

function collectChunks(text: string, deltaSize: number): string[] {
  const state = createSentenceChunkerState();
  const chunks: string[] = [];

  for (let i = 0; i < text.length; i += deltaSize) {
    chunks.push(...pushText(state, text.slice(i, i + deltaSize)));
  }

  chunks.push(...flushRemaining(state));
  return chunks;
}

describe("sentence-chunker", () => {
  it("flushes the Prague fixture in a single write", () => {
    const state = createSentenceChunkerState();
    const chunks = pushText(state, PRAGUE_RESPONSE);
    chunks.push(...flushRemaining(state));

    expect(chunks).toEqual(EXPECTED_CHUNKS);
  });

  it("flushes the Prague fixture with 1-char LLM deltas", () => {
    expect(collectChunks(PRAGUE_RESPONSE, 1)).toEqual(EXPECTED_CHUNKS);
  });

  it("flushes the Prague fixture with variable LLM delta sizes", () => {
    for (const deltaSize of [1, 3, 7, 13]) {
      expect(collectChunks(PRAGUE_RESPONSE, deltaSize)).toEqual(EXPECTED_CHUNKS);
    }
  });

  it("returns nothing when flushed with no text", () => {
    const state = createSentenceChunkerState();
    expect(flushRemaining(state)).toEqual([]);
  });

  it("merges short preambles with the following sentence", () => {
    const state = createSentenceChunkerState();
    const chunks = pushText(state, "OK. This is a longer follow-up sentence.");
    chunks.push(...flushRemaining(state));

    expect(chunks).toEqual(["OK. This is a longer follow-up sentence."]);
  });
});
