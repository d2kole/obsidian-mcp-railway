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
      // Project-wide minimums per Task #17 spec (CI pipeline & coverage):
      //   lines 80%, statements 80%, functions 70%, branches 75%.
      // Per-module higher bars (vault 90%, oauth 90%, write-path 95%,
      // rate-limit 95%) are enforced by their own `verify:<feature>`
      // scripts and remain the source of truth — see package.json.
      // `test:coverage` is NOT in the `verify:all` chain; verify:all
      // gates correctness via per-feature scripts.
      thresholds: {
        lines: 80,
        functions: 70,
        statements: 80,
        branches: 75,
      },
    },
  },
});
