#!/usr/bin/env node
// Fail if the npm tarball is missing anything the package promises.
//
// Expectations are derived, not listed. A hand-maintained list is what let
// this check drift: it required `dist/wasm/rayon-worker-bootstrap.mjs`, a path
// the build has never produced, so it was asserting the absence of a file
// nobody shipped while the real bootstrap went unchecked.
//
// Three sources of truth, all of them already load-bearing:
//
//   1. `exports` — every target it names must be in the tarball, or the
//      subpath resolves to nothing for a consumer.
//   2. Raw assets under `src/` — anything that is not TypeScript is copied by
//      the build rather than emitted by `tsc`, which is easy to forget. Each
//      one must appear at its mirrored `dist/` path. `wasm/rayon/bootstrap.mjs`
//      is the case in point: Node spawns it as a file, so a missing copy is a
//      runtime failure in the rayon pool, not a compile error.
//   3. `main`/`types`, when set.
//
// Run after `npm run build`; `npm pack` packs what is on disk.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

const packed = new Set(
    JSON.parse(
        execFileSync("npm", ["pack", "--dry-run", "--json"], {
            cwd: ROOT,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }),
    )[0].files.map((f) => f.path),
);

/** `{ path -> why it is required }`, so a failure explains itself. */
const required = new Map();

for (const [subpath, target] of Object.entries(pkg.exports ?? {})) {
    for (const file of targetsOf(target)) {
        required.set(file, `exports["${subpath}"]`);
    }
}

for (const asset of rawAssets(join(ROOT, "src"))) {
    required.set(`dist/${asset}`, `raw asset src/${asset} (copied by the build, not emitted)`);
}

for (const field of ["main", "types"]) {
    if (pkg[field]) required.set(normalise(pkg[field]), `package.json#${field}`);
}

const missing = [...required].filter(([file]) => !packed.has(file));

if (missing.length) {
    console.error("check-pack: FAIL — the tarball is missing files the package promises:\n");
    for (const [file, why] of missing) console.error(`  ${file}\n      required by ${why}`);
    console.error("\nRun `npm run build` first; if a raw asset is new, copy it in the build step.");
    process.exit(1);
}

console.log(`check-pack: OK — ${required.size} required files present in ${packed.size} packed`);

/** Flatten a conditional-exports value down to the file paths it can resolve to. */
function targetsOf(target) {
    if (typeof target === "string") return [normalise(target)];
    if (target && typeof target === "object") return Object.values(target).flatMap(targetsOf);
    return [];
}

function normalise(p) {
    return p.replace(/^\.\//, "");
}

/** Every non-TypeScript file under `src/`, as a path relative to `src/`. */
function rawAssets(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) out.push(...rawAssets(full));
        else if (!name.endsWith(".ts")) out.push(relative(join(ROOT, "src"), full));
    }
    return out;
}
