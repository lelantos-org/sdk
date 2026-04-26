// Diffs the built public API against a checked-in snapshot.
//
// The root barrel plus 30 subpaths is more surface than anyone reliably
// holds in their head — which is how eight `export *` barrels came to
// publish every @internal symbol they touched, while types that appeared in
// exported signatures (TreeStore, HttpClientOptions, OnPhase) were not
// exported at all.
//
// This makes every change to the surface a visible diff in one file.
// Run `npm run check:api -- --update` after an intentional change.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const SNAPSHOT = new URL("../api-surface.json", import.meta.url).pathname;
const PKG = new URL("../package.json", import.meta.url).pathname;
const update = process.argv.includes("--update");

const pkg = JSON.parse(readFileSync(PKG, "utf8"));

/** Exported names of a `.d.ts`, via the TypeScript compiler API. */
function surfaceOf(dtsPath) {
    const ts = require("typescript");
    const program = ts.createProgram([dtsPath], {
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        noEmit: true,
        skipLibCheck: true,
    });
    const checker = program.getTypeChecker();
    const source = program.getSourceFile(dtsPath);
    if (!source) return null;
    const sym = checker.getSymbolAtLocation(source);
    if (!sym) return [];
    return checker
        .getExportsOfModule(sym)
        .map((s) => s.getName())
        .sort();
}

const entries = Object.entries(pkg.exports)
    .filter(([, v]) => typeof v === "object" && v.types?.startsWith("./dist/"))
    .map(([name, v]) => [name, v.types.replace(/^\.\//, "")]);

const current = {};
const missing = [];
for (const [name, types] of entries) {
    if (!existsSync(types)) {
        missing.push(`${name} -> ${types}`);
        continue;
    }
    current[name] = surfaceOf(types) ?? [];
}

if (missing.length > 0) {
    console.error("check-public-api: build output missing. Run `npm run build` first.\n");
    for (const m of missing) console.error(`  ${m}`);
    process.exit(1);
}

if (update || !existsSync(SNAPSHOT)) {
    writeFileSync(SNAPSHOT, `${JSON.stringify(current, null, 2)}\n`);
    console.log(
        `check-public-api: snapshot ${update ? "updated" : "created"} (${Object.keys(current).length} subpaths)`,
    );
    process.exit(0);
}

const previous = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
const diffs = [];
for (const name of new Set([...Object.keys(previous), ...Object.keys(current)])) {
    const before = new Set(previous[name] ?? []);
    const after = new Set(current[name] ?? []);
    for (const n of before) if (!after.has(n)) diffs.push(`  - ${name}: removed \`${n}\``);
    for (const n of after) if (!before.has(n)) diffs.push(`  + ${name}: added \`${n}\``);
}

if (diffs.length > 0) {
    console.error("check-public-api: the public surface changed\n");
    for (const d of diffs.sort()) console.error(d);
    console.error(
        "\nIf intended, run `npm run check:api -- --update` and review the diff in" +
            " api-surface.json as part of the change.",
    );
    process.exit(1);
}
console.log(`check-public-api: OK — ${Object.keys(current).length} subpaths unchanged`);
