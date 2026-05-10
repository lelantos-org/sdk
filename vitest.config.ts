import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
        exclude: ["node_modules", "dist", "wasm/**/pkg/**"],
        pool: "forks",
        testTimeout: 30_000,
        hookTimeout: 30_000,
        coverage: {
            provider: "v8",
            reporter: ["text", "html", "lcov"],
            include: ["src/**/*.ts"],
            exclude: [
                "src/**/*.test.ts",
                "src/**/*test-utils*",
                "src/wasm/**",
                "src/types/**",
            ],
        },
    },
});
