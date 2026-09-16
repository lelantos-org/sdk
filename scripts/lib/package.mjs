// Paths and file walks shared by the check scripts, so every script agrees on what `src/` ships
// and none depends on the directory it is run from.

import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const SRC = join(ROOT, "src");
export const DIST = join(ROOT, "dist");
/**
 * The TypeScript compiler, loaded on first use.
 *
 * Lazy because scripts that need no parser — `check-wasm-size`, run by the CI job that builds
 * `wasm/` before any `npm ci` — would otherwise fail on a missing devDependency.
 */
export const loadTs = (() => {
    let mod;
    return () => (mod ??= createRequire(import.meta.url)("typescript"));
})();

export function readPackage() {
    return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
}

/** Every file under `dir`, as absolute paths. */
export function walk(dir) {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => join(e.parentPath, e.name));
}

/**
 * Whether a `src/`-relative path is a TypeScript module the build emits. Mirrors the `exclude`
 * list in `tsconfig.json`: tests, type tests, benches and `test-utils/` never ship.
 */
export function isShipped(rel) {
    return (
        rel.endsWith(".ts") &&
        !rel.endsWith(".d.ts") &&
        !/\.(test|test-d|bench)\.ts$/.test(rel) &&
        !rel.startsWith("test-utils/")
    );
}

/** Shipped TypeScript modules under `src/`, as `{ abs, rel }` with `rel` relative to `src/`. */
export function shippedSources() {
    return walk(SRC)
        .map((abs) => ({ abs, rel: relative(SRC, abs) }))
        .filter(({ rel }) => isShipped(rel));
}
