#!/usr/bin/env node
// Fail if a `#wasm/*` subpath is not imported with a literal specifier.
//
// Bundlers follow a dynamic import only when its specifier is a literal. Passed through a variable
// (`import(cfg.subpath)`), the bare `#wasm/...` survives into the browser bundle, where nothing
// resolves it: the module load throws, the wasm-pack glue's `new URL(...)` is never rewritten to
// the emitted asset, and every caller silently falls back to JS with no build-time error.
//
// Each subpath declared in package.json `imports` must appear at least once under src/ as a
// literal `import("#wasm/<name>")`.

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
            // The literal must sit inside the `import()` call: the same string in a `const`
            // would pass a substring match yet reach `import()` as a variable.
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
