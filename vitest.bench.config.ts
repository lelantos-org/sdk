// Heavyweight WASM/prover/scanner suites. Wired into `npm run test:bench`
// so the default `npm test` stays unit-only.

import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["src/**/*.bench.ts"],
        exclude: ["node_modules", "dist", "wasm/**/pkg/**"],
        pool: "forks",
        // The `trace`-feature prover logs its per-phase split via `console.log`
        // from inside wasm. Vitest's interceptor drops those, which is the same
        // reason `prover-parity.bench.ts` writes to `process.stdout` directly.
        disableConsoleIntercept: true,
        testTimeout: 120_000,
        hookTimeout: 60_000,
    },
});
