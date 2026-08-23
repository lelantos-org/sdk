// Emit Poseidon parity vectors shared by the SDK and the Rust backend.
// Output: tests/vectors/poseidon.json, written to *both* repos.
//
// Why this file exists: `sdk/wasm/poseidon` vendors the permutation from
// `backend/crates/fmd-crypto/src/poseidon/`, so two copies must stay
// bit-identical. The backend's own `poseidon/tests.rs` explains the hazard —
// parity against `light-poseidon` is *relative*, so a constants change under a
// version bump would move both sides together while every assertion still
// passed and every commitment and Merkle root silently changed.
//
// The two `anchors` are the values circomlibjs publishes. They are asserted
// here rather than merely emitted, so regenerating cannot quietly move the
// baseline: if `poseidon-lite` ever stops matching circomlib, generation fails
// instead of producing a new, self-consistent, wrong file.
//
// Unlike `gen-fmd-vectors.ts` this writes both copies. The two `fmd.json`s are
// kept identical by hand; doing it here is what actually guarantees the
// property this file exists to provide.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BN254_FR } from "../src/core/field.js";
import { type Field, Poseidon } from "../src/crypto/index.js";
import { TAG_FMD_BIT, TAG_IVK, TAG_LEAF, TAG_MERKLE, TAG_NF, TAG_RHO } from "../src/crypto/tags.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Published by circomlibjs. Ties this file to circomlib, not to whichever crate supplies constants. */
const ANCHORS: { label: string; inputs: bigint[]; digest: string }[] = [
    {
        label: "circomlibjs poseidon([1])",
        inputs: [1n],
        digest: "18586133768512220936620570745912940619677854269274689475585506675881198879027",
    },
    {
        label: "circomlibjs poseidon([1, 2])",
        inputs: [1n, 2n],
        digest: "7853200120776062878684798364095072458815029376092732009249414926327459813530",
    },
];

/** Deterministic LCG, so vectors reproduce bit-for-bit across runs. */
function makeRng(seed: bigint): () => Field {
    let s = seed;
    return () => {
        s = (s * 6364136223846793005n + 1442695040888963407n) & ((1n << 128n) - 1n);
        return s % BN254_FR;
    };
}

/** Production arities, from the tag table in `src/crypto/tags.ts`. */
const TAGGED: { label: string; inputs: bigint[] }[] = [
    { label: "TAG_IVK arity 2", inputs: [TAG_IVK, 42n] },
    { label: "TAG_RHO arity 3", inputs: [TAG_RHO, 7n, 3n] },
    { label: "TAG_NF arity 4", inputs: [TAG_NF, 11n, 22n, 33n] },
    { label: "TAG_LEAF arity 4", inputs: [TAG_LEAF, 1n, 2n, 3n] },
    { label: "TAG_MERKLE arity 5", inputs: [TAG_MERKLE, 4n, 5n, 6n, 7n] },
    { label: "TAG_FMD_BIT arity 6", inputs: [TAG_FMD_BIT, 8n, 9n, 10n, 11n, 12n] },
];

async function main(): Promise<void> {
    // Public API deliberately: once `build()` performs wasm init, a constructor
    // hack here would generate vectors from a backend that never initialised.
    const P = await Poseidon.build();
    const hash = (xs: bigint[]) => P.hash(xs).toString();

    for (const a of ANCHORS) {
        const got = hash(a.inputs);
        if (got !== a.digest) {
            throw new Error(
                `anchor drift: ${a.label}\n  published ${a.digest}\n  computed  ${got}`,
            );
        }
    }

    const rng = makeRng(0xf00dcafen);
    const vectors: { label: string; inputs: string[]; digest: string }[] = [];

    // Every supported arity, so trimming the wasm constant table cannot
    // silently drop one a caller uses.
    for (let arity = 1; arity <= 8; arity++) {
        const inputs = Array.from({ length: arity }, () => rng());
        vectors.push({
            label: `random arity ${arity}`,
            inputs: inputs.map(String),
            digest: hash(inputs),
        });
    }

    // Edges: the identity-looking input and the largest canonical element.
    for (const arity of [2, 5]) {
        vectors.push({
            label: `zeros arity ${arity}`,
            inputs: Array.from({ length: arity }, () => "0"),
            digest: hash(Array.from({ length: arity }, () => 0n)),
        });
        const max = BN254_FR - 1n;
        vectors.push({
            label: `field-max arity ${arity}`,
            inputs: Array.from({ length: arity }, () => max.toString()),
            digest: hash(Array.from({ length: arity }, () => max)),
        });
    }

    for (const t of TAGGED) {
        vectors.push({ label: t.label, inputs: t.inputs.map(String), digest: hash(t.inputs) });
    }

    const out = {
        version: 1,
        domain: "lelantos.poseidon.v1",
        curve: "bn254",
        constants: "circomlib bn254_x5",
        anchors: ANCHORS.map((a) => ({
            label: a.label,
            inputs: a.inputs.map(String),
            digest: a.digest,
        })),
        vectors,
    };
    const body = `${JSON.stringify(out, null, 2)}\n`;

    for (const rel of [
        "../tests/vectors/poseidon.json",
        "../../backend/tests/vectors/poseidon.json",
    ]) {
        const p = resolve(__dirname, rel);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, body);
        console.log(`wrote ${p}`);
    }
    console.log(`${ANCHORS.length} anchors, ${vectors.length} vectors`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
