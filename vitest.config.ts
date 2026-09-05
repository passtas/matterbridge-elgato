import { defineConfig } from "vitest/config";

export default defineConfig({
  cacheDir: ".cache/vitest",
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    globals: true,
    // The platform tests share Matterbridge/Matter process state, so they must not
    // run concurrently with each other (docs/matterbridge-api-cheatsheet.md §5).
    fileParallelism: false,
    // matterbridge is `npm link`ed from the global prefix, so its test harness cannot
    // resolve `vitest` on its own – inline it so vite resolves imports from here.
    server: { deps: { inline: [/matterbridge/] } },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      // Set to what the suite actually achieves, with a little headroom.
      thresholds: {
        lines: 87,
        statements: 86,
        functions: 85,
        branches: 78,
      },
    },
  },
});
