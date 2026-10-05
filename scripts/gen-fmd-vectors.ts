// Emit deterministic FMD test vectors for the Rust indexer impl.
// Output: tests/vectors/fmd.json (relative to sdk/).
//
// Each vector pins:
//   - detection key x_i
//   - flag key X_i = B · x_i, with B = Base8
//   - flag scalar r
//   - clue (R_packed, c_bits, gamma)
//   - test result against own dk (must be true)
//   - test result against a foreign dk (sampled, must be false unless lucky)
//
// The vectors exercise `fmdFlagOnBase`/`fmdTest` on raw γ-component keys, pinning the clue wire
// format independently of key derivation. Per-address key expansion is pinned by
// `tests/vectors/diversified.json`.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BABYJUB_SUBGROUP_ORDER, type Field, Jubjub, Poseidon } from "../src/crypto/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

import { fmdFlagOnBase, fmdTest } from "../src/fmd/clue.js";
import { encodeClue } from "../src/fmd/codec.js";
import { type FmdDetectionKey, fmdFlagKeyFromDetection } from "../src/fmd/keys.js";

function bytesHex(b: Uint8Array): string {
    return `0x${Array.from(b, (v) => v.toString(16).padStart(2, "0")).join("")}`;
}

// Deterministic LCG so vectors reproduce bit-for-bit across runs.
function makeRng(seed: bigint): () => Field {
    let s = seed;
    return () => {
        s = (s * 6364136223846793005n + 1442695040888963407n) & ((1n << 128n) - 1n);
        return s % BABYJUB_SUBGROUP_ORDER;
    };
}

interface Vector {
    label: string;
    gamma: number;
    dk_x: string[];
    fk_X: { x: string; y: string }[];
    r: string;
    clue_R: string;
    clue_bits: string;
    clue_encoded: string;
    detect_self: boolean;
    detect_other: boolean;
}

async function main() {
    const J = await Jubjub.build();
    const P = await Poseidon.build();
    const rngA = makeRng(0xa11cen);
    const rngB = makeRng(0xb0bn);
    const gammas = [3, 5, 8];
    const vectors: Vector[] = [];

    for (const gamma of gammas) {
        const dkA: FmdDetectionKey = { x: Array.from({ length: gamma }, () => rngA()) };
        const dkB: FmdDetectionKey = { x: Array.from({ length: gamma }, () => rngB()) };
        const fkA = fmdFlagKeyFromDetection(J, dkA, J.base8);
        const r = rngA();
        const clue = fmdFlagOnBase(J, P, fkA, J.base8, r);

        vectors.push({
            label: `gamma=${gamma}`,
            gamma,
            dk_x: dkA.x.map((x) => x.toString()),
            fk_X: fkA.X.map((P) => ({ x: P[0].toString(), y: P[1].toString() })),
            r: r.toString(),
            clue_R: bytesHex(clue.R),
            clue_bits: bytesHex(clue.bits),
            clue_encoded: bytesHex(encodeClue(clue)),
            detect_self: fmdTest(J, P, dkA, clue),
            detect_other: fmdTest(J, P, dkB, clue),
        });
    }

    const out = {
        version: 2,
        domain: "lelantos.fmd.v1",
        curve: "babyjubjub",
        hash: "poseidon",
        scheme: "poseidon-legendre",
        vectors,
    };

    const outPath = resolve(__dirname, "../tests/vectors/fmd.json");
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
    console.log(`wrote ${outPath} — ${vectors.length} clue`);
    for (const v of vectors) {
        if (!v.detect_self) throw new Error(`self-detect failed for ${v.label}`);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
