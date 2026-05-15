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
      // Starting gate per Task #6 spec: 70% lines / 70% statements /
      // 60% functions / 60% branches. `test:coverage` will fail at the
      // current ~25% baseline — that gap is the explicit work downstream
      // TDD tasks (#7-#11) close. `test:coverage` is intentionally NOT in
      // the `verify` chain (verify gates correctness, coverage gates
      // sufficiency); see TESTING.md.
      thresholds: {
        lines: 70,
        functions: 60,
        statements: 70,
        branches: 60,
      },
    },
  },
});
