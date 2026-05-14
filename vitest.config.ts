import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
        // `*.bench.ts` files are heavyweight WASM/prover suites — run them
        // explicitly via `npm run test:bench`. Keeps default `npm test` fast.
        exclude: ["node_modules", "dist", "wasm/**/pkg/**", "src/**/*.bench.ts"],
        pool: "forks",
        testTimeout: 30_000,
        hookTimeout: 30_000,
        coverage: {
            provider: "v8",
            reporter: ["text", "html", "lcov"],
            include: ["src/**/*.ts"],
            exclude: [
                "src/**/*.test.ts",
                "src/**/*.bench.ts",
                "src/**/*test-utils*",
                "src/wasm/**",
                "src/types-ambient/**",
            ],
        },
    },
});
