#!/usr/bin/env node
// Fail if anything under `src/` draws randomness from a non-cryptographic
// source.
//
// This is a privacy SDK: note blinders, the ECDH ephemeral, the FMD clue
// blinder, the output-slot shuffle and the note-selection tiebreak are all
// randomness, and all of them stop working if the draw is predictable. The
// shuffle is the clearest case — it is the only thing keeping a spend's public
// output commitments from being labelled payee-vs-relayer by slot index, so a
// `Math.random()` in it is a privacy hole with no visible symptom, no failing
// test, and no compiler complaint.
//
// Everything must go through `core/random.ts`, which is backed by Web Crypto
// and throws when it is unavailable rather than degrading. The allowlist below
// is for the genuine non-security uses.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SRC = join(ROOT, "src");

const PATTERNS = [
    { re: /\bMath\s*\.\s*random\b/, what: "Math.random" },
    // `crypto.randomUUID` is CSPRNG-backed, but it is a formatted 122-bit
    // identifier rather than a draw, and reaching for it here means bypassing
    // core/random.ts. Named so the reason is on the record.
    { re: /\brandomUUID\b/, what: "crypto.randomUUID" },
];

/**
 * Files permitted to draw from a non-cryptographic source, with the reason.
 * Anything added here should be provably outside the privacy surface.
 */
const ALLOW = new Map([
    ["src/core/async.ts", "retry backoff jitter — anti-thundering-herd, not a secret"],
]);

/** @type {Array<{file: string, line: number, what: string, text: string}>} */
const hits = [];

function walk(dir) {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) {
            walk(full);
        } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
            // Tests included on purpose: a test that seeds a shuffle with
            // Math.random is asserting the wrong thing, and a test helper is
            // one import away from shipping.
            scan(full);
        }
    }
}

function scan(file) {
    const rel = relative(ROOT, file);
    if (ALLOW.has(rel)) return;
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const { re, what } of PATTERNS) {
            if (re.test(line)) {
                hits.push({ file: rel, line: i + 1, what, text: line.trim() });
                break;
            }
        }
    }
}

walk(SRC);

if (hits.length > 0) {
    console.error(`check-entropy: ${hits.length} non-cryptographic random source(s) under src/:`);
    for (const h of hits) {
        console.error(`  ${h.file}:${h.line}  ${h.what}  —  ${h.text}`);
    }
    console.error(
        "\nDraw from core/random.ts instead (randomBytes / randomFr / randomJubjubScalar /" +
            "\nrandomBelow / shuffled / noteId). If the use is genuinely outside the privacy" +
            "\nsurface, add the file to ALLOW in scripts/check-entropy.mjs with the reason.",
    );
    process.exit(1);
}

const allowed = [...ALLOW.keys()].join(", ");
console.log(`check-entropy: OK — no non-cryptographic randomness under src/ (allowed: ${allowed})`);
