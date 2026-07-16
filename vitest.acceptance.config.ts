import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/acceptance/**/*.test.ts"],
    testTimeout: 360_000, // 6 minutes per test — init/deploy make LLM calls
    hookTimeout: 60_000,
    sequence: {
      // Run tests sequentially — they share API keys and modify ~/.config
      concurrent: false,
    },
  },
});
