import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/acceptance/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["cli/lib/**", "src/actions/**"],
    },
  },
});
