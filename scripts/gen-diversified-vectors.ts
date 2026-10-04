// Emit the cross-language vectors for diversified addresses.
// Output: tests/vectors/diversified.json (relative to sdk/).
//
// Run: `npx tsx scripts/gen-diversified-vectors.ts`
//
// `src/test-utils/diversified-vectors.ts` defines the content, the derivations it pins and the
// encoding of every field. `src/diversified-vectors.test.ts` fails when the committed file differs
// from a fresh build, so a change to any derivation requires rerunning this script.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Jubjub } from "../src/crypto/jubjub-wasm/index.js";
import { Poseidon } from "../src/crypto/poseidon.js";
import {
    buildDiversifiedVectors,
    serializeDiversifiedVectors,
} from "../src/test-utils/diversified-vectors.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
    const J = await Jubjub.build();
    const P = await Poseidon.build();
    const vectors = buildDiversifiedVectors(J, P);

    const outPath = resolve(__dirname, "../tests/vectors/diversified.json");
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, serializeDiversifiedVectors(vectors));
    console.log(
        `wrote ${outPath} — ${vectors.addresses.length} addresses, ` +
            `${vectors.diversified_base.length} bases, ${vectors.fmd.clues.length} clues, ` +
            `${vectors.seed.length} seeds`,
    );
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
