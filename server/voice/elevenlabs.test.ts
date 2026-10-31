import { describe, expect, it } from "vitest";
import {
  DEFAULT_TTS_MODEL,
  ELEVENLABS_OUTPUT_FORMAT,
  ElevenLabsError,
  synthesizeSpeech,
  type FetchLike,
} from "./elevenlabs.js";

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** A fetch that records what it was asked and answers with `audio`. */
function fakeFetch(audio: Buffer, calls: Call[]): FetchLike {
  return async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      text: async () => "",
      arrayBuffer: async () => audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.length),
    };
  };
}

describe("synthesizeSpeech", () => {
  it("asks for raw 24 kHz PCM from the given voice and returns the samples", async () => {
    const calls: Call[] = [];
    const audio = Buffer.from(Int16Array.of(1, -1, 2, -2).buffer);

    const pcm = await synthesizeSpeech(
      { text: "Hello there.", voiceId: "voice-1" },
      { apiKey: "test-key", fetch: fakeFetch(audio, calls) },
    );

    expect(pcm).toEqual(audio);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      `https://api.elevenlabs.io/v1/text-to-speech/voice-1?output_format=${ELEVENLABS_OUTPUT_FORMAT}`,
    );
    expect(ELEVENLABS_OUTPUT_FORMAT).toBe("pcm_24000");
    expect(calls[0]?.headers["xi-api-key"]).toBe("test-key");
    expect(calls[0]?.body).toEqual({ text: "Hello there.", model_id: DEFAULT_TTS_MODEL });
  });

  it("passes the model and seed through when given, so a render repeats", async () => {
    const calls: Call[] = [];
    await synthesizeSpeech(
      { text: "Hi.", voiceId: "voice-2", modelId: "eleven_multilingual_v2", seed: 1234 },
      { apiKey: "k", fetch: fakeFetch(Buffer.alloc(4), calls) },
    );

    expect(calls[0]?.body).toEqual({
      text: "Hi.",
      model_id: "eleven_multilingual_v2",
      seed: 1234,
    });
  });

  it("reports the API's own message on failure, without the key", async () => {
    const failing: FetchLike = async () => ({
      ok: false,
      status: 401,
      text: async () => '{"detail":{"message":"missing the permission voices_read"}}',
      arrayBuffer: async () => new ArrayBuffer(0),
    });

    const error = await synthesizeSpeech(
      { text: "Hi.", voiceId: "v" },
      { apiKey: "secret-key", fetch: failing },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ElevenLabsError);
    expect((error as ElevenLabsError).status).toBe(401);
    expect((error as Error).message).toContain("voices_read");
    expect((error as Error).message).not.toContain("secret-key");
  });

  it("rejects a response with no audio in it", async () => {
    const empty: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () => "",
      arrayBuffer: async () => new ArrayBuffer(0),
    });

    await expect(
      synthesizeSpeech({ text: "Hi.", voiceId: "v" }, { apiKey: "k", fetch: empty }),
    ).rejects.toThrow(/0 bytes of audio/);
  });

  it("drops a trailing half sample rather than handing on an odd byte count", async () => {
    const odd: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () => "",
      arrayBuffer: async () => new ArrayBuffer(5),
    });

    const pcm = await synthesizeSpeech({ text: "Hi.", voiceId: "v" }, { apiKey: "k", fetch: odd });
    expect(pcm).toHaveLength(4);
  });
});
