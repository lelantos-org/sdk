// Type-checks the `ts` code blocks in README.md and SDK.md against `src/`.
//
// Documentation is API surface. Without this the examples drift silently: the
// README quickstart accumulated three separate type errors — a `connect()`
// call the option union rejected, a bare `bigint` passed where a branded
// `AssetId` was required, and a `wallet.asset()` result that `formatAmount`
// would not accept.
//
// Each block becomes one virtual module under a temp dir, wrapped in an async
// IIFE so top-level `await` works, and prefixed with `docs-preamble.ts` for
// the identifiers examples reference without defining (`rpcUrl`, `signer`, …).
//
// Blocks that are deliberately not standalone — type definitions, shell-ish
// pseudocode, fragments showing a single field — opt out with an HTML comment
// on the line before the fence:
//
//     <!-- typecheck: skip -->
//
// Run: npm run check:docs

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = join(ROOT, ".docs-typecheck");
const DOCS = ["README.md", "SDK.md"];
const SKIP = /<!--\s*typecheck:\s*skip\s*-->/;

/** Fenced ```ts / ```typescript blocks, with the line they start on. */
function blocks(md) {
    const lines = md.split("\n");
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        if (!/^```(ts|typescript)\s*$/.test(lines[i])) continue;
        const skip = i > 0 && SKIP.test(lines[i - 1]);
        const body = [];
        let j = i + 1;
        for (; j < lines.length && !/^```\s*$/.test(lines[j]); j++) body.push(lines[j]);
        if (!skip) out.push({ line: i + 1, code: body.join("\n") });
        i = j;
    }
    return out;
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// One shared ambient module, not a per-file prefix: `declare global` repeated
// across files collides (TS6200).
writeFileSync(join(OUT, "globals.d.ts"), readFileSync(join(ROOT, "scripts", "docs-preamble.ts"), "utf8"));
// Wildcard module declarations only work in a script-scope file; the preamble
// has imports, which makes it a module and turns these into augmentations.
writeFileSync(
    join(OUT, "assets.d.ts"),
    '// Bundler asset imports (`?url`) used by the browser examples.\n' +
        'declare module "*?url" {\n    const url: string;\n    export default url;\n}\n',
);

const index = [];
let n = 0;

for (const doc of DOCS) {
    const found = blocks(readFileSync(join(ROOT, doc), "utf8"));
    for (const b of found) {
        const name = `${doc.replace(/\W+/g, "_")}_L${b.line}.ts`;
        // Imports must hoist out of the IIFE, so they are lifted verbatim.
        // A multi-line `import { … } from "…"` runs until its `from` clause.
        const imports = [];
        const body = [];
        let inImport = false;
        for (const line of b.code.split("\n")) {
            if (!inImport && /^\s*import\s/.test(line)) inImport = true;
            if (inImport) {
                imports.push(line);
                if (/\bfrom\s+["']/.test(line) || /^\s*import\s+["']/.test(line)) inImport = false;
                continue;
            }
            body.push(line);
        }
        writeFileSync(
            join(OUT, name),
            `${imports.join("\n")}\nexport async function __block() {\n${body.join("\n")}\n}\n`,
        );
        index.push({ name, doc, line: b.line });
        n++;
    }
}

writeFileSync(
    join(OUT, "tsconfig.json"),
    JSON.stringify(
        {
            extends: join(relative(OUT, ROOT), "tsconfig.json"),
            compilerOptions: {
                noEmit: true,
                rootDir: relative(OUT, ROOT),
                declaration: false,
                declarationMap: false,
                types: ["node"],
                // Examples elide unused bindings and partial destructures for
                // brevity; neither indicates a broken example.
                noUnusedLocals: false,
                noUnusedParameters: false,
            },
            include: ["*.ts", "*.d.ts"],
            // The base config excludes node_modules and tests; neither applies
            // here, and inheriting them empties the program.
            exclude: [],
        },
        null,
        2,
    ),
);

let output = "";
try {
    execFileSync(join(ROOT, "node_modules", ".bin", "tsc"), ["--noEmit", "-p", join(OUT, "tsconfig.json")], {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
    });
} catch (err) {
    output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
}

if (output.trim()) {
    // Map generated filenames back to the doc and line the block came from.
    for (const { name, doc, line } of index) {
        output = output.replaceAll(name, `${doc}:${line} (block)`);
    }
    process.stdout.write(output);
    console.error(`check-docs: FAILED — ${n} blocks from ${DOCS.join(", ")}`);
    process.exit(1);
}

console.log(`check-docs: OK — ${n} blocks type-check`);
