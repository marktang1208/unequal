import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts", "scripts/**/*.test.ts"],
    // Miniflare boot is slow (workerd spin-up + module load + migration apply),
    // so bump the default 5s timeout to 30s. Hooks (beforeAll/afterAll) share
    // the same budget for the same reason.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
