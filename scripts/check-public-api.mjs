// Diffs the built public API against a checked-in snapshot.
//
// Two checks:
//   1. Every change to the surface is a visible diff in one file. Run
//      `npm run check:api -- --update` after an intentional change.
//   2. One home per name: a name published from two subpaths fails, whether it is one symbol
//      re-exported twice or two symbols sharing a name. Consumers should never have to choose
//      between two import paths for the same thing.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadTs, ROOT, readPackage } from "./lib/package.mjs";

const ts = loadTs();

const SNAPSHOT = join(ROOT, "api-surface.json");
const update = process.argv.includes("--update");

const entries = Object.entries(readPackage().exports)
    .filter(([, v]) => typeof v === "object" && v.types?.startsWith("./dist/"))
    .map(([subpath, v]) => [subpath, join(ROOT, v.types)]);

const missing = entries.filter(([, types]) => !existsSync(types));
if (missing.length > 0) {
    console.error("check-public-api: build output missing. Run `npm run build` first.\n");
    for (const [subpath, types] of missing) console.error(`  ${subpath} -> ${types}`);
    process.exit(1);
}

// One program over every entry: the declaration graphs overlap almost entirely.
const program = ts.createProgram(
    entries.map(([, types]) => types),
    {
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        noEmit: true,
        skipLibCheck: true,
    },
);
const checker = program.getTypeChecker();

/** Exported names of a `.d.ts`. */
function surfaceOf(types) {
    const sym = checker.getSymbolAtLocation(program.getSourceFile(types));
    return sym
        ? checker
              .getExportsOfModule(sym)
              .map((s) => s.getName())
              .sort()
        : [];
}

const current = Object.fromEntries(entries.map(([subpath, types]) => [subpath, surfaceOf(types)]));

const homes = new Map();
for (const [subpath, names] of Object.entries(current)) {
    for (const n of names) homes.set(n, [...(homes.get(n) ?? []), subpath]);
}
const duplicated = [...homes].filter(([, subpaths]) => subpaths.length > 1);
if (duplicated.length > 0) {
    console.error("check-public-api: a name is published from more than one subpath\n");
    for (const [n, subpaths] of duplicated) console.error(`  ${n}: ${subpaths.join(", ")}`);
    console.error("\nPick one home in the entries under src/entry/.");
    process.exit(1);
}

if (update || !existsSync(SNAPSHOT)) {
    writeFileSync(SNAPSHOT, `${JSON.stringify(current, null, 2)}\n`);
    console.log(
        `check-public-api: snapshot ${update ? "updated" : "created"} (${entries.length} subpaths)`,
    );
    process.exit(0);
}

const previous = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
const diffs = [];
for (const subpath of new Set([...Object.keys(previous), ...Object.keys(current)])) {
    const before = new Set(previous[subpath] ?? []);
    const after = new Set(current[subpath] ?? []);
    for (const n of before) if (!after.has(n)) diffs.push(`  - ${subpath}: removed \`${n}\``);
    for (const n of after) if (!before.has(n)) diffs.push(`  + ${subpath}: added \`${n}\``);
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
console.log(`check-public-api: OK — ${entries.length} subpaths unchanged`);
