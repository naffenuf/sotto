import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // The browser's audio conversion (US-012) is pure and testable in node.
    include: ["server/**/*.test.ts", "shared/**/*.test.ts", "web/src/**/*.test.ts"],
    exclude: ["**/*.integration.test.ts"],
  },
});
