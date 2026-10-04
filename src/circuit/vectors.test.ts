// Cross-repo parity against the golden vectors shipped by `@lelantos-org/circuits`, read out of
// the installed package via its `./vectors` export so no second copy can drift.
//
// The circuits repo owns the circom, and so the layout. Neither repo imports code from the
// other; the vectors are the contract between them, and their `y` and `digest` values come from
// witnesses produced by the compiled circuit. A disagreement here means the SDK would build a
// witness the deployed verifier rejects.
//
// Covered at every shape in `TRANSACT_SHAPES`: the tag table, the empty-subtree ladder, key
// derivation, note commitments (`inner`, then `cm`, which is the leaf), nullifiers, dummy input
// slots, output rho, the quaternary Merkle tree, FMD clues, the coefficient layout and digest,
// the challenge preimage and its ABI encoding, Fiat-Shamir `z`, the circuit's `y`, and the full
// witness built by `toCircomInput`.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { encodeAbiParameters, keccak256, toBytes } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import { bitAt } from "../core/bits.js";
import { BABYJUB_SUBGROUP_ORDER, BN254_FR } from "../core/field.js";
import {
    buildInner,
    buildNoteCommitment,
    buildNullifierFromNsk,
    buildRho,
    commitWithInner,
    deriveIvk,
    deriveNk,
    derivePk,
    type Field,
    type Jubjub,
    MerkleTree,
    type Point,
    Poseidon,
    TAG_CM,
    TAG_DIGEST,
    TAG_DK,
    TAG_FMD_BIT,
    TAG_INNER,
    TAG_IVK,
    TAG_MERKLE,
    TAG_NF,
    TAG_NK,
    TAG_PK,
    TAG_RHO,
} from "../crypto/index.js";
import { fmdFlag } from "../fmd/clue.js";
import { fmdFlagKeyFromDetection } from "../fmd/keys.js";
import { challengeWordCount, coeffCount, shapeId, TRANSACT_SHAPES } from "../protocol/shape.js";
import { loadJubjub, wasmDescribe } from "../test-utils/wasm.js";
import {
    coeffDigest,
    coeffs,
    fiatShamirZ,
    flatten,
    hornerEval,
    transactDigest,
} from "./compression.js";
import { circuitSignals, type TransactWitnessBundle, toCircomInput } from "./input.js";
import { dummyInputAt } from "./spent-note.js";

interface VectorIndex {
    schema: string;
    generator: string;
    files: Record<string, { sha256: string; coeffCount: number; layoutDigest: string }>;
}

interface PointJson {
    x: string;
    y: string;
}

interface CircuitMeta {
    id: string;
    template: string;
    shape: { depth: number; nIn?: number; nOut?: number; maxL?: number };
    /** Words the polynomial evaluates into `y` and the digest absorbs. */
    coeffCount: number;
    /** Words hashed into `z`: the coefficients, the digest word, then `challengeOnly`. */
    challengeWords: number;
    /** The verifier's public signals, in order. */
    publicSignals: string[];
    layout: string[];
    layoutDigest: string;
    /** Witness keys that are hashed into `z` and are not circuit signals. */
    challengeOnly: string[];
}

interface Constants {
    bn254Fr: string;
    babyjubSubgroupOrder: string;
    babyjubBase8: PointJson;
    tags: Record<string, string>;
    emptySubtree: string[];
}

interface Compression {
    /** Every word hashed into `z`: `coeffs`, then `digest`, then the challenge-only words. */
    challenge: string[];
    /** `abi.encode(uint256[] challenge)`: the keccak preimage of `z`. */
    abiEncodedChallenge: string;
    /** The leading words of `challenge`: what `y` evaluates. */
    coeffs: string[];
    /** `CoeffDigest(coeffs)`: the circuit's second public signal. */
    digest: string;
    zDerivation: string;
    z: string;
    y: string;
}

/** What the compiled circuit's witness emitted. */
interface CircuitOutput {
    y: string;
    digest: string;
}

interface TransactVector {
    name: string;
    expect: string;
    intermediates: {
        keys: { nsk: string; ivk: string; nk: string; d: string; pk: string }[];
        inputs: {
            slot: number;
            isDummy: boolean;
            inner: string;
            cm: string;
            nf: string;
            leafIndex: number;
        }[];
        realLeaves: { slot: number; leaf: string; leafIndex: number }[];
        dummies: { slot: number; rho: string }[];
        outputs: { slot: number; rho: string; inner: string; cm: string }[];
        digest: { absorbed: string[]; value: string };
        merkle: {
            depth: number;
            leaves: string[];
            root: string;
            proofs: { leafIndex: number; pathElements: string[][]; pathIndices: number[] }[];
        };
        fmd: {
            gamma: number;
            dkX: string[];
            fkX: PointJson[];
            perOutput: {
                slot: number;
                r: string;
                cluePackedR: string;
                clueBitsPacked: string;
                clueRx: string;
                clueRy: string;
                clueBits: string;
            }[];
        };
    };
    /** Exactly the bundle `toCircomInput` emits; `rebuilds the whole witness` pins the key set. */
    witness: TransactWitnessBundle;
    compression: Compression;
    circuitOutput: CircuitOutput;
}

interface TreeUpdateWitness {
    z: string;
    old_root: string;
    new_root: string;
    start_index: string;
    actual_count: string;
    cms: string[];
    leaf_asset: string[];
    leaf_public_in: string[];
    is_deposit: string[];
    frontier_in: string[][];
}

interface TreeUpdateVector {
    name: string;
    expect: string;
    intermediates: {
        startIndex: number;
        actualCount: number;
        oldRoot: string;
        newRoot: string;
        frontierIn: string[][];
        leaves: {
            slot: number;
            /** The calldata word: the commitment on a spend leaf, `inner` on a deposit leaf. */
            cms: string;
            /** What the tree holds. */
            leaf: string;
            leafAsset: string;
            leafPublicIn: string;
            isDeposit: number;
            note: {
                asset: string;
                value: string;
                pk: string;
                rho: string;
                rcm: string;
                inner: string;
            };
        }[];
    };
    witness: TreeUpdateWitness;
    compression: Compression;
    circuitOutput: CircuitOutput;
}

interface VectorFile<V> {
    schema: string;
    circuit: CircuitMeta;
    constants: Constants;
    vectors: V[];
}

// `@lelantos-org/circuits/vectors` resolves to the package's `vectors/index.json`; the
// per-circuit files sit beside it. Resolving through the package, not a relative path, keeps the
// installed package the single source.
//
// The package lives on GitHub Packages, so installing it needs a token with `read:packages` (the
// `NODE_AUTH_TOKEN` env in `.github/workflows/ci.yml`). Without it this suite throws at import
// instead of skipping, so the parity check cannot go silently absent.
const require_ = createRequire(import.meta.url);
const VECTOR_DIR = new URL(".", pathToFileURL(require_.resolve("@lelantos-org/circuits/vectors")));

function readVectorFile(name: string): Uint8Array {
    return new Uint8Array(readFileSync(new URL(name, VECTOR_DIR)));
}

function loadJson<T>(name: string): T {
    return JSON.parse(new TextDecoder().decode(readVectorFile(name))) as T;
}

const index = loadJson<VectorIndex>("index.json");

// The batch vector is named for the circuit's `MAX_L`, which is not part of `CircuitShape`. The
// name is read from the index so a widened batch fails an assertion here instead of raising
// ENOENT at import time.
const BATCH_FILE = Object.keys(index.files).find((name) =>
    /^tree-update-batch-\d+\.json$/.test(name),
);
if (BATCH_FILE === undefined) {
    throw new Error(
        `no tree-update-batch-<MAX_L>.json in the published vector index: ${Object.keys(index.files).join(", ")}`,
    );
}
const treeUpdate = loadJson<VectorFile<TreeUpdateVector>>(BATCH_FILE);

/** One published transact shape and the vector file that pins it. */
interface TransactSet {
    /** `"4x6"` — names the `describe` block so a failure says which. */
    readonly id: string;
    readonly file: VectorFile<TransactVector>;
}

// Driven by `TRANSACT_SHAPES`, so a shape the SDK supports but the package has
// no vector file for fails at load time instead of going uncovered.
const TRANSACT: readonly TransactSet[] = TRANSACT_SHAPES.map((shape) => {
    const id = shapeId(shape);
    return { id, file: loadJson<VectorFile<TransactVector>>(`transact-${id}.json`) };
});

// The constants block is identical across every file (asserted by `every vector file agrees on
// the constants` below), so one file stands in for all of them.
const BASELINE = TRANSACT[0]?.file;
if (!BASELINE) throw new Error("vectors.test: TRANSACT_SHAPES is empty");

/** Every file this suite parses, transact and tree-update alike. */
const ALL_FILES: readonly VectorFile<TransactVector | TreeUpdateVector>[] = [
    ...TRANSACT.map((t) => t.file),
    treeUpdate,
];

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    peerDependencies: Record<string, string>;
    devDependencies: Record<string, string>;
};

// A missing slot is a broken vector file: `f` and `pt` throw instead of decoding `undefined`.
const f = (s: string | undefined): Field => {
    if (s === undefined) throw new Error("vector file: missing field element");
    return BigInt(s);
};
const pt = (p: PointJson | undefined): Point => {
    if (p === undefined) throw new Error("vector file: missing point");
    return [BigInt(p.x), BigInt(p.y)];
};
const hex = (b: Uint8Array): string => `0x${Buffer.from(b).toString("hex")}`;

/** `abi.encode(uint256[] words)`: the bytes `fiatShamirZ` hashes. */
const abiEncodeWords = (words: readonly Field[]): string =>
    encodeAbiParameters([{ type: "uint256[]" }], [words]);

/**
 * The checks every vector's `compression` block must pass, whichever circuit it belongs to.
 * `want` is the SDK's own coefficient vector, challenge preimage and `z` for the vector's
 * witness, so the published lists are compared, not trusted.
 */
function expectCompression(
    v: { compression: Compression; circuitOutput: CircuitOutput },
    want: { coeffs: Field[]; challenge: Field[]; z: string },
): void {
    const c = v.compression;
    expect(c.coeffs.map(f)).toEqual(want.coeffs);
    expect(c.challenge.map(f)).toEqual(want.challenge);
    // The coefficients lead the preimage and the digest word follows them.
    expect(c.challenge.slice(0, c.coeffs.length)).toEqual(c.coeffs);
    expect(c.challenge[c.coeffs.length]).toBe(c.digest);

    // digest: recomputed from the coefficients, and equal to the circuit's output.
    expect(coeffDigest(want.coeffs)).toBe(f(c.digest));
    expect(c.digest).toBe(v.circuitOutput.digest);

    // z: Fiat-Shamir over the whole preimage, whose ABI encoding is published.
    expect(c.zDerivation).toBe("fiat-shamir");
    expect(abiEncodeWords(want.challenge)).toBe(c.abiEncodedChallenge);
    expect(BigInt(keccak256(c.abiEncodedChallenge as `0x${string}`)) % BN254_FR).toBe(f(c.z));
    expect(fiatShamirZ(want.challenge)).toBe(f(c.z));
    expect(want.z).toBe(c.z);
    expect(f(c.z)).not.toBe(0n);

    // y: comes from the compiled circuit's witness, so this pins the SDK to the
    // deployed verifier.
    const y = hornerEval(want.coeffs, f(c.z));
    expect(y).toBe(f(c.y));
    expect(c.y).toBe(v.circuitOutput.y);
}

const CIRCUITS_PKG = "@lelantos-org/circuits";

describe("installed circuit vectors", () => {
    it("matches the sha256 digests recorded in index.json", () => {
        for (const [name, meta] of Object.entries(index.files)) {
            const got = createHash("sha256").update(readVectorFile(name)).digest("hex");
            expect(got, name).toBe(meta.sha256);
        }
    });

    // The witness layout is a consensus contract, so the vectors must come from the exact
    // circuits release the SDK declares as its peer: a stale install or a one-sided version bump
    // fails here instead of at the verifier. Both ranges are exact pins for the same reason.
    it("was generated by the pinned @lelantos-org/circuits version", () => {
        const pinned = pkg.peerDependencies[CIRCUITS_PKG];
        expect(pkg.devDependencies[CIRCUITS_PKG]).toBe(pinned);
        expect(index.generator).toBe(`${CIRCUITS_PKG}@${pinned}`);
    });

    it("carries the schema this suite parses", () => {
        expect(index.schema).toBe("lelantos.circuits.vectors/2");
        for (const file of ALL_FILES) {
            expect(file.schema).toBe(index.schema);
        }
    });

    it("indexes each file's coefficient count and layout digest", () => {
        const files = new Map<string, VectorFile<unknown>>([
            ...TRANSACT.map(({ id, file }) => [`transact-${id}.json`, file] as const),
            [BATCH_FILE, treeUpdate],
        ]);
        expect([...files.keys()].sort()).toEqual(Object.keys(index.files).sort());
        for (const [name, file] of files) {
            expect(index.files[name]?.coeffCount, name).toBe(file.circuit.coeffCount);
            expect(index.files[name]?.layoutDigest, name).toBe(file.circuit.layoutDigest);
        }
    });

    it("exposes [y, digest, z] as every circuit's public signals", () => {
        for (const file of ALL_FILES) {
            expect(file.circuit.publicSignals).toEqual(["y", "digest", "z"]);
        }
    });

    it("publishes only accepting vectors", () => {
        for (const file of ALL_FILES) {
            expect(file.vectors.length).toBeGreaterThan(0);
            for (const v of file.vectors) expect(v.expect, v.name).toBe("accept");
        }
    });
});

/**
 * The polynomial's slot labels, as named by `circuit.layout`, in the order `coeffs` emits
 * coefficients. The circuits repo dumps the same list from its Lean model and hashes it into
 * `layoutDigest`, so reproducing the digest shows the two orderings agree name for name, not
 * only in length.
 *
 * The digest word, the five binding words, the clue triples and the aux digest are hashed into
 * `z` and never evaluated, so they are absent.
 */
function slotLabels(nIn: number, nOut: number): string[] {
    const labels = ["merkleRoot"];
    for (let i = 0; i < nIn; i++) labels.push(`nullifier ${i}`);
    for (let j = 0; j < nOut; j++) labels.push(`outCm ${j}`);
    labels.push("publicAssetId", "publicOut");
    return labels;
}

describe.each(TRANSACT)("transact $id public-input layout", ({ file }) => {
    const { nIn = 0, nOut = 0 } = file.circuit.shape;

    it("emits the circuit's slot order", () => {
        expect(slotLabels(nIn, nOut)).toEqual(file.circuit.layout);
    });

    it("reproduces the circuit's layout digest", () => {
        const digest = keccak256(toBytes(slotLabels(nIn, nOut).join("\n")));
        expect(digest).toBe(file.circuit.layoutDigest);
    });

    it("evaluates 3 + N_IN + N_OUT coefficients and hashes 10 + N_IN + 4·N_OUT", () => {
        // `coeffCount` and `challengeWordCount` in protocol/shape.ts must reproduce what the
        // package publishes. The difference is the digest word plus the words the circuit has
        // no signal for, which bind through `z` alone.
        expect(file.circuit.coeffCount).toBe(coeffCount({ nIn, nOut }));
        expect(file.circuit.challengeWords).toBe(challengeWordCount({ nIn, nOut }));
        expect(file.circuit.layout).toHaveLength(file.circuit.coeffCount);
        for (const v of file.vectors) {
            expect(coeffs(v.witness), v.name).toHaveLength(file.circuit.coeffCount);
            expect(flatten(v.witness), v.name).toHaveLength(file.circuit.challengeWords);
        }
    });

    it("passes the calculator exactly the witness keys the circuit declares", () => {
        // Every witness key is a circuit input signal, the digest word, or one of
        // the published challenge-only words. The witness calculator rejects an
        // unknown or missing key, and `shape-proving.test.ts` runs it.
        for (const v of file.vectors) {
            const signals = new Set(Object.keys(circuitSignals(v.witness)));
            const dropped = Object.keys(v.witness).filter((k) => !signals.has(k));
            expect(dropped.sort(), v.name).toEqual(
                ["digest", ...file.circuit.challengeOnly].sort(),
            );
            expect(signals.has("y"), v.name).toBe(false);
        }
    });
});

describe("consensus constants", () => {
    const c = BASELINE.constants;

    it("shares the field moduli", () => {
        expect(BN254_FR).toBe(f(c.bn254Fr));
        expect(BABYJUB_SUBGROUP_ORDER).toBe(f(c.babyjubSubgroupOrder));
    });

    it("shares the domain-separation tag table", () => {
        expect({
            TAG_CM,
            TAG_NF,
            TAG_PK,
            TAG_IVK,
            TAG_MERKLE,
            TAG_DK,
            TAG_FMD_BIT,
            TAG_NK,
            TAG_RHO,
            TAG_INNER,
            TAG_DIGEST,
        }).toEqual(Object.fromEntries(Object.entries(c.tags).map(([k, v]) => [k, f(v)])));
    });

    it("every vector file agrees on the constants", () => {
        for (const file of ALL_FILES) {
            expect(file.constants).toEqual(c);
        }
    });

    // The circuit tabulates this ladder as literals (circom does not constant-fold Poseidon);
    // the SDK recomputes it in MerkleTree's constructor. An empty tree of depth d must land on
    // entry d.
    it("shares the empty-subtree hash ladder", async () => {
        const P = await Poseidon.build();
        for (let depth = 1; depth < c.emptySubtree.length; depth++) {
            expect(new MerkleTree(P, depth).root(), `depth ${depth}`).toBe(
                f(c.emptySubtree[depth]),
            );
        }
    });
});

wasmDescribe("transact vectors", () => {
    let P: Poseidon;
    let J: Jubjub;

    beforeAll(async () => {
        P = await Poseidon.build();
        J = await loadJubjub();
    });

    it("shares the Baby-Jubjub base point", () => {
        expect(J.base8).toEqual(pt(BASELINE.constants.babyjubBase8));
    });

    for (const { id, file } of TRANSACT) {
        describe(id, () => {
            for (const v of file.vectors) {
                describe(v.name, () => {
                    const w = v.witness;
                    const im = v.intermediates;

                    it("derives the key hierarchy from nsk", () => {
                        for (const k of im.keys) {
                            const nsk = f(k.nsk);
                            expect(deriveIvk(P, nsk)).toBe(f(k.ivk));
                            expect(deriveNk(P, nsk)).toBe(f(k.nk));
                            expect(derivePk(P, nsk, f(k.d))).toBe(f(k.pk));
                        }
                    });

                    // The witness carries no `in_pk`: the circuit derives each slot's pk from
                    // its nsk and in_d, so the commitment only rebuilds under that key.
                    it("rebuilds every spent note under the pk derived from nsk and in_d", () => {
                        expect(im.inputs).toHaveLength(w.nullifier.length);
                        im.inputs.forEach((slot, i) => {
                            expect(slot.slot).toBe(i);
                            if (slot.isDummy) expect(w.in_d[i], `in_d ${i}`).toBe("0");
                            const note = {
                                asset: f(w.in_asset[i]),
                                value: f(w.in_value[i]),
                                pk: derivePk(P, f(w.in_nsk[i]), f(w.in_d[i])),
                                rho: f(w.in_rho[i]),
                                rcm: f(w.in_rcm[i]),
                            };
                            const inner = buildInner(P, note);
                            expect(inner, `inner ${i}`).toBe(f(slot.inner));
                            const cm = buildNoteCommitment(P, note);
                            expect(cm, `cm ${i}`).toBe(f(slot.cm));
                            expect(commitWithInner(P, note.asset, note.value, inner)).toBe(cm);
                            const nf = buildNullifierFromNsk(P, f(w.in_nsk[i]), note.rho, cm);
                            expect(nf, `nf ${i}`).toBe(f(slot.nf));
                            expect(w.nullifier[i]).toBe(slot.nf);
                            expect(w.in_is_dummy[i]).toBe(slot.isDummy ? "1" : "0");
                        });
                    });

                    it("rebuilds every dummy input slot from its nsk, rho and rcm", () => {
                        const dummySlots = im.inputs.filter((s) => s.isDummy).map((s) => s.slot);
                        expect(im.dummies.map((d) => d.slot)).toEqual(dummySlots);
                        for (const { slot, rho } of im.dummies) {
                            // The vectors' dummies carry their own `nsk` and `rcm`.
                            const d = dummyInputAt(P, im.merkle.depth, {
                                nsk: f(w.in_nsk[slot]),
                                rho: f(rho),
                                rcm: f(w.in_rcm[slot]),
                            });
                            expect(d.cm, `cm ${slot}`).toBe(f(im.inputs[slot]?.cm));
                            expect(d.nf, `nf ${slot}`).toBe(f(w.nullifier[slot]));
                            expect(
                                [d.asset, d.value, d.rho, d.rcm, d.nsk, d.d].map(String),
                                `fields ${slot}`,
                            ).toEqual([
                                w.in_asset[slot],
                                w.in_value[slot],
                                w.in_rho[slot],
                                w.in_rcm[slot],
                                w.in_nsk[slot],
                                w.in_d[slot],
                            ]);
                            expect(d.pathElements.map((level) => level.map(String))).toEqual(
                                w.in_path_elements[slot],
                            );
                            expect(d.pathIndices.map(String)).toEqual(w.in_path_indices[slot]);
                        }
                    });

                    it("rebuilds every output note", () => {
                        expect(im.outputs).toHaveLength(w.out_cm.length);
                        im.outputs.forEach((slot, j) => {
                            expect(slot.slot).toBe(j);
                            // Output rho is bound to the first input nullifier and the
                            // slot index: the faerie-gold defense.
                            expect(buildRho(P, f(w.nullifier[0]), j), `rho ${j}`).toBe(f(slot.rho));
                            expect(w.out_rho[j]).toBe(slot.rho);
                            const note = {
                                asset: f(w.out_asset[j]),
                                value: f(w.out_value[j]),
                                pk: f(w.out_pk[j]),
                                rho: f(w.out_rho[j]),
                                rcm: f(w.out_rcm[j]),
                            };
                            expect(buildInner(P, note), `inner ${j}`).toBe(f(slot.inner));
                            expect(buildNoteCommitment(P, note), `cm ${j}`).toBe(f(slot.cm));
                            expect(w.out_cm[j]).toBe(slot.cm);
                        });
                    });

                    it("inserts each real input's cm as its tree leaf", () => {
                        const realSlots = im.inputs.filter((s) => !s.isDummy);
                        expect(im.realLeaves.map((l) => l.slot)).toEqual(
                            realSlots.map((s) => s.slot),
                        );
                        for (const leaf of im.realLeaves) {
                            expect(leaf.leaf, `slot ${leaf.slot}`).toBe(im.inputs[leaf.slot]?.cm);
                            expect(leaf.leafIndex).toBe(im.inputs[leaf.slot]?.leafIndex);
                            expect(im.merkle.leaves[leaf.leafIndex]).toBe(leaf.leaf);
                        }
                    });

                    it("names no asset unless it withdraws", () => {
                        if (f(w.public_out) === 0n) expect(w.public_asset_id).toBe("0");
                    });

                    it("rebuilds the Merkle root and the membership proofs", () => {
                        expect(im.merkle.depth).toBe(file.circuit.shape.depth);
                        const tree = new MerkleTree(P, im.merkle.depth);
                        tree.bulkInsert(im.merkle.leaves.map(f));
                        expect(tree.root()).toBe(f(im.merkle.root));
                        expect(w.merkle_root).toBe(im.merkle.root);
                        expect(im.merkle.proofs.map((p) => p.leafIndex)).toEqual(
                            im.realLeaves.map((l) => l.leafIndex),
                        );

                        for (const p of im.merkle.proofs) {
                            const got = tree.proof(p.leafIndex);
                            expect(got.pathIndices, `indices ${p.leafIndex}`).toEqual(
                                p.pathIndices,
                            );
                            expect(got.pathElements, `elements ${p.leafIndex}`).toEqual(
                                p.pathElements.map((level) => level.map(f)),
                            );
                        }
                    });

                    it("derives the FMD clues bound into the proof", () => {
                        const dk = { x: im.fmd.dkX.map(f) };
                        const fk = fmdFlagKeyFromDetection(J, dk);
                        expect(fk.X).toEqual(im.fmd.fkX.map(pt));

                        for (const out of im.fmd.perOutput) {
                            const clue = fmdFlag(J, P, fk, f(out.r));
                            expect(clue.gamma).toBe(im.fmd.gamma);
                            expect(hex(clue.R)).toBe(out.cluePackedR);
                            expect(hex(clue.bits)).toBe(out.clueBitsPacked);

                            const R = J.unpackPoint(clue.R);
                            expect(R).not.toBeNull();
                            expect(R?.[0]).toBe(f(out.clueRx));
                            expect(R?.[1]).toBe(f(out.clueRy));

                            // clueBits packs the γ clue bits LSB-first into one
                            // field element, exactly as `buildOutputAux` does.
                            let bits = 0n;
                            for (let i = 0; i < clue.gamma; i++) {
                                if (bitAt(clue.bits, i)) bits |= 1n << BigInt(i);
                            }
                            expect(bits).toBe(f(out.clueBits));

                            // The clue words the challenge binds are these.
                            expect(w.out_clue_Rx[out.slot]).toBe(out.clueRx);
                            expect(w.out_clue_Ry[out.slot]).toBe(out.clueRy);
                            expect(w.out_clue_bits[out.slot]).toBe(out.clueBits);
                        }
                        expect(im.fmd.perOutput).toHaveLength(w.out_cm.length);
                    });

                    it("commits the coefficients with the digest the circuit outputs", () => {
                        expect(coeffs(w)).toEqual(im.digest.absorbed.map(f));
                        expect(coeffDigest(im.digest.absorbed.map(f))).toBe(f(im.digest.value));
                        expect(transactDigest(w)).toBe(f(im.digest.value));
                        // The calldata word an honest prover sends is that digest.
                        expect(w.digest).toBe(im.digest.value);
                        expect(w.digest).toBe(v.circuitOutput.digest);
                    });

                    it("flattens to the challenge preimage, derives z and evaluates y", () => {
                        expect(v.compression.coeffs).toHaveLength(file.circuit.coeffCount);
                        expect(v.compression.challenge).toHaveLength(file.circuit.challengeWords);
                        expectCompression(v, {
                            coeffs: coeffs(w),
                            challenge: flatten(w),
                            z: w.z,
                        });
                    });

                    it("orders the binding words after the digest", () => {
                        const tail = flatten(w).slice(file.circuit.coeffCount);
                        const clues = w.out_cm.flatMap((_, j) => [
                            w.out_clue_Rx[j],
                            w.out_clue_Ry[j],
                            w.out_clue_bits[j],
                        ]);
                        expect(tail).toEqual(
                            [
                                w.digest,
                                w.recipient_address,
                                w.chain_id,
                                w.payer_address,
                                w.relayer_address,
                                w.intent_hash,
                                ...clues,
                                w.out_aux_digest,
                            ].map(f),
                        );
                    });

                    it("rebuilds the whole witness with toCircomInput", () => {
                        const spent = im.inputs.map((slot, i) => ({
                            asset: f(w.in_asset[i]),
                            value: f(w.in_value[i]),
                            pk: derivePk(P, f(w.in_nsk[i]), f(w.in_d[i])),
                            rho: f(w.in_rho[i]),
                            rcm: f(w.in_rcm[i]),
                            nsk: f(w.in_nsk[i]),
                            d: f(w.in_d[i]),
                            cm: f(slot.cm),
                            nf: f(slot.nf),
                            leafIndex: slot.leafIndex,
                            pathElements: (w.in_path_elements[i] ?? []).map((level) =>
                                level.map(f),
                            ),
                            pathIndices: (w.in_path_indices[i] ?? []).map(Number),
                            isDummy: slot.isDummy,
                        }));
                        const outputs = im.outputs.map((_, j) => ({
                            asset: f(w.out_asset[j]),
                            value: f(w.out_value[j]),
                            pk: f(w.out_pk[j]),
                            rho: f(w.out_rho[j]),
                            rcm: f(w.out_rcm[j]),
                        }));

                        const built = toCircomInput(P, {
                            publicAssetId: f(w.public_asset_id),
                            publicOut: f(w.public_out),
                            inputs: spent,
                            outputs,
                            outputClues: im.outputs.map((_, j) => ({
                                clueBits: f(w.out_clue_bits[j]),
                                clueRx: f(w.out_clue_Rx[j]),
                                clueRy: f(w.out_clue_Ry[j]),
                            })),
                            merkleRoot: f(w.merkle_root),
                            recipientAddress: f(w.recipient_address),
                            chainId: f(w.chain_id),
                            payerAddress: f(w.payer_address),
                            relayerAddress: f(w.relayer_address),
                            intentHash: f(w.intent_hash),
                            z: f(w.z),
                            outputAuxDigest: f(w.out_aux_digest),
                        });

                        // `toEqual` on the whole object: a key the vector lacks, or
                        // one `toCircomInput` omits, fails. `digest` is computed
                        // by `toCircomInput`, not passed in.
                        expect(built).toEqual(w);
                        expect(Object.keys(built)).toEqual(Object.keys(w));
                    });
                });
            }
        });
    }
});

// The SDK does not prove `tree_update_batch` (the relayer owns its zkey), but it builds the notes
// whose leaves go into it and mirrors the tree the circuit updates, so both must agree. A
// deposit's leaf is never a calldata word: the circuit builds it from the public (asset, amount)
// and the published `inner`, and whoever tracks the tree computes it the same way.

/** `BatchCompress`'s slot names, in coefficient order. */
function batchSlotLabels(maxL: number): string[] {
    const labels = ["oldRoot", "newRoot", "startIndex", "actualCount"];
    for (const group of ["cms", "leafAsset", "leafPublicIn", "isDeposit"]) {
        for (let k = 0; k < maxL; k++) labels.push(`${group} ${k}`);
    }
    return labels;
}

/** `BatchCompress`'s coefficient vector for a batch witness. */
function batchCoeffs(w: TreeUpdateWitness): Field[] {
    return [
        w.old_root,
        w.new_root,
        w.start_index,
        w.actual_count,
        ...w.cms,
        ...w.leaf_asset,
        ...w.leaf_public_in,
        ...w.is_deposit,
    ].map(f);
}

describe("tree_update_batch public-input layout", () => {
    const { circuit } = treeUpdate;
    const maxL = circuit.shape.maxL ?? 0;

    it("emits the circuit's slot order and layout digest", () => {
        expect(batchSlotLabels(maxL)).toEqual(circuit.layout);
        expect(keccak256(toBytes(batchSlotLabels(maxL).join("\n")))).toBe(circuit.layoutDigest);
    });

    it("evaluates 4 + 4·MAX_L coefficients and hashes one more word, the digest", () => {
        expect(BATCH_FILE).toBe(`tree-update-batch-${maxL}.json`);
        expect(circuit.coeffCount).toBe(4 + 4 * maxL);
        expect(circuit.challengeWords).toBe(circuit.coeffCount + 1);
        // Every batch signal is evaluated: none is bound through `z` alone.
        expect(circuit.challengeOnly).toEqual([]);
    });

    it("fits one spend's outputs in a batch", () => {
        for (const { file } of TRANSACT) {
            expect(file.circuit.shape.nOut).toBeLessThanOrEqual(maxL);
            expect(file.circuit.shape.depth).toBe(circuit.shape.depth);
        }
    });
});

describe("tree_update_batch vectors", () => {
    let P: Poseidon;

    beforeAll(async () => {
        P = await Poseidon.build();
    });

    for (const v of treeUpdate.vectors) {
        describe(v.name, () => {
            const im = v.intermediates;
            const w = v.witness;

            it("builds each leaf the way the circuit does", () => {
                expect(im.leaves).toHaveLength(im.actualCount);
                for (const leaf of im.leaves) {
                    const note = {
                        asset: f(leaf.note.asset),
                        value: f(leaf.note.value),
                        pk: f(leaf.note.pk),
                        rho: f(leaf.note.rho),
                        rcm: f(leaf.note.rcm),
                    };
                    const inner = buildInner(P, note);
                    expect(inner, `inner ${leaf.slot}`).toBe(f(leaf.note.inner));
                    // Either way the tree holds the note's commitment.
                    expect(buildNoteCommitment(P, note), `leaf ${leaf.slot}`).toBe(f(leaf.leaf));

                    if (leaf.isDeposit === 1) {
                        // A deposit publishes `inner` beside its public amount.
                        expect(leaf.cms).toBe(leaf.note.inner);
                        expect(leaf.leafAsset).toBe(leaf.note.asset);
                        expect(leaf.leafPublicIn).toBe(leaf.note.value);
                        expect(
                            commitWithInner(
                                P,
                                f(leaf.leafAsset),
                                f(leaf.leafPublicIn),
                                f(leaf.cms),
                            ),
                        ).toBe(f(leaf.leaf));
                    } else {
                        // A spend leaf is inserted as the `outCm` it is.
                        expect(leaf.isDeposit).toBe(0);
                        expect(leaf.cms).toBe(leaf.leaf);
                        expect(leaf.leafAsset).toBe("0");
                        expect(leaf.leafPublicIn).toBe("0");
                    }
                }
            });

            it("carries the leaves in the witness and zeroes the unused slots", () => {
                const maxL = treeUpdate.circuit.shape.maxL ?? 0;
                const column = (pick: (l: (typeof im.leaves)[number]) => string): string[] =>
                    Array.from({ length: maxL }, (_, k) => {
                        const leaf = im.leaves[k];
                        return leaf ? pick(leaf) : "0";
                    });
                expect(w.cms).toEqual(column((l) => l.cms));
                expect(w.leaf_asset).toEqual(column((l) => l.leafAsset));
                expect(w.leaf_public_in).toEqual(column((l) => l.leafPublicIn));
                expect(w.is_deposit).toEqual(column((l) => String(l.isDeposit)));
                expect(w.old_root).toBe(im.oldRoot);
                expect(w.new_root).toBe(im.newRoot);
                expect(w.start_index).toBe(String(im.startIndex));
                expect(w.actual_count).toBe(String(im.actualCount));
                expect(w.frontier_in).toEqual(im.frontierIn);
            });

            // Batches that start mid-tree carry only a frontier, not the leaves already
            // committed, so the root is reproducible off-chain only from index 0.
            const fromEmpty = im.startIndex === 0;
            it.runIf(fromEmpty)("reproduces old and new roots from an empty tree", () => {
                const tree = new MerkleTree(P, treeUpdate.circuit.shape.depth);
                expect(tree.root()).toBe(f(im.oldRoot));
                expect(tree.frontier()).toEqual(im.frontierIn.map((level) => level.map(f)));
                tree.bulkInsert(im.leaves.slice(0, im.actualCount).map((l) => f(l.leaf)));
                expect(tree.root()).toBe(f(im.newRoot));
            });

            it("agrees on the digest, the Fiat-Shamir challenge and the PolyEval output", () => {
                const coeffs = batchCoeffs(w);
                expect(coeffs).toHaveLength(treeUpdate.circuit.coeffCount);
                expect(v.compression.challenge).toHaveLength(treeUpdate.circuit.challengeWords);
                // The batch preimage is the coefficients, then the digest word.
                expectCompression(v, {
                    coeffs,
                    challenge: [...coeffs, coeffDigest(coeffs)],
                    z: w.z,
                });
            });
        });
    }
});
