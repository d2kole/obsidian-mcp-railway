import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/**/*.test.ts",
      "tests/unit/**/*.test.ts",
      "tests/integration/**/*.test.ts",
    ],
    exclude: ["tests/e2e/**", "node_modules/**", "dist/**"],
    environment: "node",
    globals: false,
    pool: "forks",
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.d.ts",
        "src/index.ts",
      ],
      // Baseline thresholds match current coverage so `test:coverage` is
      // green from day one. Each feature task in this batch is expected to
      // raise the corresponding number when it lands its tests. Long-term
      // target documented in TESTING.md is 70% lines / 60% branches.
      thresholds: {
        lines: 25,
        functions: 50,
        statements: 25,
        branches: 60,
      },
    },
  },
});
