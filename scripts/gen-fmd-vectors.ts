// Emit deterministic FMD test vectors for the Rust indexer impl.
// Output: tests/vectors/fmd.json (relative to sdk/).
//
// Each vector pins:
//   - detection key x_i
//   - flag key X_i = B · x_i
//   - flag scalar r
//   - clue (R_packed, c_bits, gamma)
//   - test result against own dk (must be true)
//   - test result against a foreign dk (sampled, must be false unless lucky)
//
// The `vectors` block exercises `fmdFlag`/`fmdTest` on raw γ-component keys,
// pinning the clue wire format independently of key derivation.
//
// The `expansion` block pins the clue-key derivation: the root secret
// `dk_root`, the published `ck = B·dk_root`, and the two halves `x_i` / `X_i`,
// which must satisfy `X_i = B·x_i`.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BABYJUB_SUBGROUP_ORDER, type Field, Jubjub, Poseidon } from "../src/crypto/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

import {
    encodeClue,
    type FmdDetectionKey,
    fmdClueKeyFromRoot,
    fmdExpandDetectionKey,
    fmdExpandFlagKey,
    fmdFlag,
    fmdFlagKeyFromDetection,
    fmdTest,
} from "../src/fmd/index.js";

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

interface ExpansionVector {
    label: string;
    gamma: number;
    /** Root detection secret. Never appears in an address. */
    dk_root: string;
    /** Published clue key `B · dk_root`, the only FMD material in an address. */
    ck: { x: string; y: string };
    ck_packed: string;
    /** `x_i = dk_root + h_i (mod q)` — the expanded detection key. */
    dk_x: string[];
    /** `X_i = ck + B·h_i` — the expanded flag key. Must equal `B · x_i`. */
    fk_X: { x: string; y: string }[];
    r: string;
    clue_encoded: string;
    detect_self: boolean;
    /** A second root, `dk_root + 1`, used for the negative case. */
    other_root: string;
    /**
     * Whether `other_root` also detects the clue. `true` is the designed
     * 2^-gamma false positive (1/32 at the gamma=5 default), so the value is
     * pinned rather than asserted false.
     */
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
        const fkA = fmdFlagKeyFromDetection(J, dkA);
        const r = rngA();
        const clue = fmdFlag(J, P, fkA, r);

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

    const rngRoot = makeRng(0xc1ea5en);
    const expansion: ExpansionVector[] = [];

    for (const gamma of gammas) {
        const dkRoot = rngRoot();
        const ck = fmdClueKeyFromRoot(J, dkRoot);
        const detection = fmdExpandDetectionKey(J, P, dkRoot, gamma);
        // Expanded from `ck` alone, as a sender holding only the address does.
        const flag = fmdExpandFlagKey(J, P, ck, gamma);
        const otherRoot = dkRoot + 1n;
        const other = fmdExpandDetectionKey(J, P, otherRoot, gamma);
        const r = rngRoot();
        const clue = fmdFlag(J, P, flag, r);

        for (let i = 0; i < gamma; i++) {
            const expect = J.mulPointEscalar(J.base8, detection.x[i]!);
            const got = flag.X[i]!;
            if (expect[0] !== got[0] || expect[1] !== got[1]) {
                throw new Error(`expansion halves disagree at i=${i}, gamma=${gamma}`);
            }
        }

        expansion.push({
            label: `gamma=${gamma}`,
            gamma,
            dk_root: dkRoot.toString(),
            ck: { x: ck[0].toString(), y: ck[1].toString() },
            ck_packed: bytesHex(J.packPoint(ck)),
            dk_x: detection.x.map((x) => x.toString()),
            fk_X: flag.X.map((pt) => ({ x: pt[0].toString(), y: pt[1].toString() })),
            r: r.toString(),
            clue_encoded: bytesHex(encodeClue(clue)),
            detect_self: fmdTest(J, P, detection, clue),
            other_root: otherRoot.toString(),
            detect_other: fmdTest(J, P, other, clue),
        });
    }

    const out = {
        version: 4,
        domain: "lelantos.fmd.v4",
        curve: "babyjubjub",
        hash: "poseidon",
        scheme: "poseidon-legendre",
        vectors,
        expansion,
    };

    const outPath = resolve(__dirname, "../tests/vectors/fmd.json");
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
    console.log(`wrote ${outPath} — ${vectors.length} clue, ${expansion.length} expansion`);
    for (const v of [...vectors, ...expansion]) {
        if (!v.detect_self) throw new Error(`self-detect failed for ${v.label}`);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
