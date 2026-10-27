import { describe, expect, it } from "vitest";
import { DEFAULT_PORT, HOST, loadConfig, MissingApiKeyError } from "./config.js";

describe("loadConfig", () => {
  it("returns the key and the default port", () => {
    expect(loadConfig({ MODEL_API_KEY: "test-key" })).toEqual({
      modelApiKey: "test-key",
      port: DEFAULT_PORT,
    });
  });

  it("honours PORT", () => {
    expect(loadConfig({ MODEL_API_KEY: "test-key", PORT: "9001" }).port).toBe(9001);
  });

  it("throws a clear error when MODEL_API_KEY is missing", () => {
    expect(() => loadConfig({})).toThrow(MissingApiKeyError);
    expect(() => loadConfig({})).toThrow(/MODEL_API_KEY is missing/);
  });

  it("treats a blank MODEL_API_KEY as missing", () => {
    expect(() => loadConfig({ MODEL_API_KEY: "   " })).toThrow(MissingApiKeyError);
  });

  it("rejects a non-numeric PORT", () => {
    expect(() => loadConfig({ MODEL_API_KEY: "test-key", PORT: "nope" })).toThrow(/PORT must be/);
  });

  it("binds to loopback only", () => {
    expect(HOST).toBe("127.0.0.1");
  });
});
