import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // The browser's audio conversion (US-012) is pure and testable in node.
    include: ["server/**/*.test.ts", "shared/**/*.test.ts", "web/src/**/*.test.ts"],
    exclude: ["**/*.integration.test.ts"],
    // No test here touches the network, but a few replay a whole capture
    // through the assembler at `max` speed, which is CPU-bound and measured
    // 4.3-5.5 s for `brainstorm` — either side of Vitest's 5 s default, so the
    // suite failed at random. Wide enough for those, short enough that a
    // genuinely hung test still fails the run.
    testTimeout: 15_000,
  },
});
