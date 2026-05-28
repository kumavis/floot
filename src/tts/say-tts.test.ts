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
});
