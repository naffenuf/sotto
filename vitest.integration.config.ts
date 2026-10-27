import { defineConfig } from "vitest/config";

/** Integration tests call the real Meta APIs; they are never part of `npm test`. */
export default defineConfig({
  test: {
    environment: "node",
    include: ["server/**/*.integration.test.ts"],
    globalSetup: ["server/test/integrationSetup.ts"],
    testTimeout: 60_000,
  },
});
