import { describe, expect, it, vi } from "vitest";
import { SayTTSStream } from "./say-tts.js";

const PRAGUE_RESPONSE = `It seems like the "google" command isn't available on your system. I'll provide you with some general information about top things to do in Prague:

1. Visit Charles Bridge for its beautiful architecture and street performers.
2. Explore the historic Old Town Square, including the famous Astronomical Clock.
3. Walk through Petřín Tower for panoramic views of the city.
4. Discover the stunning St. Vitus Cathedral within Prague Castle.
5. Take a stroll along the Vltava River and enjoy the city's scenic beauty.

Would you like more specific information or help with something else?`;

describe("SayTTSStream", () => {
  it("queues the same chunks as sentence-chunker for the Prague fixture", async () => {
    const stream = new SayTTSStream("/tmp", "Fiona (Enhanced)");
    const synthesized: string[] = [];

    vi.spyOn(
      stream as unknown as { synthesize: (text: string) => Promise<Buffer> },
      "synthesize"
    ).mockImplementation(async (text: string) => {
      synthesized.push(text);
      return Buffer.alloc(0);
    });

    const done = new Promise<void>((resolve) => stream.once("done", resolve));

    for (const char of PRAGUE_RESPONSE) {
      stream.write(char);
    }
    stream.end();
    await done;

    expect(synthesized).toEqual([
      `It seems like the "google" command isn't available on your system.`,
      `I'll provide you with some general information about top things to do in Prague:`,
      `1. Visit Charles Bridge for its beautiful architecture and street performers.`,
      `2. Explore the historic Old Town Square, including the famous Astronomical Clock.`,
      `3. Walk through Petřín Tower for panoramic views of the city.`,
      `4. Discover the stunning St. Vitus Cathedral within Prague Castle.`,
      `5. Take a stroll along the Vltava River and enjoy the city's scenic beauty.`,
      `Would you like more specific information or help with something else?`,
    ]);
  });

  it("abort drops queued sentences and stops further synthesis", async () => {
    const stream = new SayTTSStream("/tmp", "Fiona (Enhanced)");
    const synthesized: string[] = [];
    let releaseFirst: (() => void) | null = null;

    vi.spyOn(
      stream as unknown as { synthesize: (text: string) => Promise<Buffer> },
      "synthesize"
    ).mockImplementation(async (text: string) => {
      synthesized.push(text);
      if (synthesized.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return Buffer.alloc(0);
    });

    const done = new Promise<void>((resolve) => stream.once("done", resolve));

    stream.write("Sentence one. Sentence two. Sentence three.");
    stream.end();

    // Wait until the first synthesize call has been made (and is blocked).
    while (!releaseFirst) {
      await new Promise((r) => setTimeout(r, 0));
    }

    stream.abort();
    (releaseFirst as () => void)();

    await done;

    // Only the first sentence is in flight when abort fires; the rest of
    // the queue is dropped without being synthesized.
    expect(synthesized).toEqual(["Sentence one."]);
  });

  it("abort after end-of-stream is a no-op for already-finished work", async () => {
    const stream = new SayTTSStream("/tmp", "Fiona (Enhanced)");

    vi.spyOn(
      stream as unknown as { synthesize: (text: string) => Promise<Buffer> },
      "synthesize"
    ).mockImplementation(async () => Buffer.alloc(0));

    let doneCount = 0;
    stream.on("done", () => doneCount++);

    stream.write("Hello.");
    stream.end();
    await new Promise<void>((resolve) =>
      stream.once("done", () => resolve())
    );

    stream.abort();
    // abort after natural completion shouldn't emit a second `done`
    expect(doneCount).toBe(1);
  });

  it("write/end after abort are no-ops", async () => {
    const stream = new SayTTSStream("/tmp", "Fiona (Enhanced)");
    const synthesizeSpy = vi.spyOn(
      stream as unknown as { synthesize: (text: string) => Promise<Buffer> },
      "synthesize"
    ).mockResolvedValue(Buffer.alloc(0));

    stream.abort();
    stream.write("Should not synthesize.");
    stream.end();

    await new Promise((r) => setTimeout(r, 10));
    expect(synthesizeSpy).not.toHaveBeenCalled();
  });
});
