import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("GET /api/health", () => {
  it("returns { ok: true }", async () => {
    app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });
});

describe("listen", () => {
  it("binds to 127.0.0.1 only", async () => {
    app = await buildApp();
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    expect(address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});
