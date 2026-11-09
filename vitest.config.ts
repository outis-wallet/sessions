import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // `npm run coverage`. What the tests reached on 2026-11-08: raise them as coverage grows, never lower them.
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "json-summary"],
      thresholds: { statements: 98, branches: 98, functions: 100, lines: 99 },
    },
  },
});
