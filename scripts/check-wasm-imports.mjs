#!/usr/bin/env node
// Fail if a `#wasm/*` subpath is not imported with a literal specifier.
//
// Bundlers only follow a dynamic import whose specifier they can read
// statically. Route one through a variable — `import(cfg.subpath)` — and the
// bare `#wasm/...` survives into the browser bundle, where nothing resolves it:
// the module load throws, the wasm-pack glue never gets its `new URL(...)`
// rewritten to the emitted asset, and every caller silently degrades to its JS
// fallback. That is invisible at build time and costs ~2.5x at runtime, so it
// is pinned here rather than left to review.
//
// Each subpath declared in package.json `imports` must appear at least once
// under src/ as a literal `import("#wasm/<name>")`.

import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { ROOT, readPackage, SRC, walk } from "./lib/package.mjs";

const pkg = readPackage();
const subpaths = Object.keys(pkg.imports ?? {}).filter((s) => s.startsWith("#wasm/"));

/** @type {Map<string, string>} `#wasm/<name>` → `file:line` of its literal import. */
const found = new Map();

function scan(file) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
        for (const sub of subpaths) {
            // The specifier must be a literal *inside the `import()` call* — the
            // same string sitting in a `const` above would pass a bare substring
            // match while still reaching `import()` as a variable.
            const literal = new RegExp(`\\bimport\\(\\s*["']${sub}["']\\s*\\)`);
            if (literal.test(lines[i]) && !found.has(sub)) {
                found.set(sub, `${relative(ROOT, file)}:${i + 1}`);
            }
        }
    }
}

for (const file of walk(SRC)) if (file.endsWith(".ts")) scan(file);

const missing = subpaths.filter((s) => !found.has(s));
if (missing.length > 0) {
    console.error(`check-wasm-imports: ${missing.length} subpath(s) never imported literally:`);
    for (const s of missing) console.error(`  ${s}`);
    console.error(
        '\nEach must reach `import()` as a literal, e.g. `() => import("#wasm/poseidon")`.\n' +
            "Passing the specifier through a variable leaves it unresolvable in browser bundles.",
    );
    process.exit(1);
}

console.log(`check-wasm-imports: OK — ${subpaths.length} subpaths imported literally`);
for (const s of subpaths) console.log(`  ${s.padEnd(16)} ${found.get(s)}`);
