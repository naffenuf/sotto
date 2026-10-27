import { describe, expect, it } from "vitest";
import OpenAI from "openai";
import { config as loadDotenv } from "dotenv";

loadDotenv({ quiet: true });

const apiKey = (process.env.MODEL_API_KEY ?? "").trim();

describe.skipIf(apiKey === "")("Meta Model API reachability", () => {
  it("answers a minimal chat completion", async () => {
    const client = new OpenAI({ apiKey, baseURL: "https://api.meta.ai/v1" });
    const completion = await client.chat.completions.create({
      model: "muse-spark-1.3",
      // muse-spark-1.3 reasons before it answers: even a trivial prompt burns
      // ~150-200 reasoning tokens, so max_tokens must leave room for them or
      // the response comes back with content: null and finish_reason: "length".
      max_tokens: 512,
      messages: [{ role: "user", content: "Name the capital of France in one word." }],
    });
    const choice = completion.choices[0];
    expect(choice?.finish_reason).toBe("stop");
    expect(choice?.message.content ?? "").toMatch(/Paris/i);
  });
});
