// Heavyweight WASM/prover/scanner suites. Wired into `npm run test:bench`
// so the default `npm test` stays unit-only.

import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["src/**/*.bench.ts"],
        exclude: ["node_modules", "dist", "wasm/**/pkg/**"],
        pool: "forks",
        testTimeout: 120_000,
        hookTimeout: 60_000,
    },
});
