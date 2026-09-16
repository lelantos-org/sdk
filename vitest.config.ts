import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // `tests/` holds JSON vectors only; every suite is colocated under `src/`.
        include: ["src/**/*.test.ts"],
        pool: "forks",
        testTimeout: 30_000,
        hookTimeout: 30_000,
        // `*.test-d.ts` files assert types only: `@ts-expect-error` directives and `expectTypeOf`.
        // Vitest checks them with the test tsconfig, in the same run.
        typecheck: {
            enabled: true,
            include: ["src/**/*.test-d.ts"],
            tsconfig: "./tsconfig.test.json",
        },
        coverage: {
            provider: "v8",
            reporter: ["text", "html", "lcov"],
            include: ["src/**/*.ts"],
            exclude: [
                "src/**/*.test.ts",
                "src/**/*.test-d.ts",
                "src/**/*.bench.ts",
                "src/test-utils/**",
                "src/runtime/wasm/**",
                "src/types-ambient/**",
            ],
        },
    },
});
