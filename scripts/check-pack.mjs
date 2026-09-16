#!/usr/bin/env node
// Fail if the npm tarball is missing a raw asset the build copies rather than emits.
//
// Anything under `src/` that is not TypeScript is copied into `dist/` by the build instead of being
// emitted by `tsc`, which is easy to forget. Each one must appear at its mirrored `dist/` path.
// `runtime/wasm/rayon/bootstrap.mjs` is the case in point: Node spawns it as a file, so a missing
// copy is a runtime failure in the rayon pool, not a compile error.
//
// Targets named by `exports`, `main` and `types` are publint's job (`check:publish`), which also
// packs before linting. Run after `npm run build`; `npm pack` packs what is on disk.

import { execFileSync } from "node:child_process";
import { relative } from "node:path";
import { ROOT, SRC, walk } from "./lib/package.mjs";

const packed = new Set(
    JSON.parse(
        execFileSync("npm", ["pack", "--dry-run", "--json"], {
            cwd: ROOT,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }),
    )[0].files.map((f) => f.path),
);

const assets = walk(SRC)
    .filter((f) => !f.endsWith(".ts"))
    .map((f) => relative(SRC, f));
const missing = assets.filter((a) => !packed.has(`dist/${a}`));

if (missing.length) {
    console.error("check-pack: FAIL — the tarball is missing raw assets copied by the build:\n");
    for (const a of missing) console.error(`  dist/${a}  (from src/${a})`);
    console.error("\nRun `npm run build` first; if a raw asset is new, copy it in the build step.");
    process.exit(1);
}
console.log(
    `check-pack: OK — ${assets.length} raw asset(s) present in ${packed.size} packed files`,
);
