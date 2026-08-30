// Cross-repo parity against the golden vectors shipped by
// `@lelantos-org/circuits`, read out of the installed package via its
// `./vectors` export so no second copy can drift.
//
// The circuits repo owns the circom, and so the layout. Neither repo imports
// code from the other; the vectors are the contract between them, and their
// `y` values come from witnesses produced by the compiled circuit. A
// disagreement here means the SDK would build a witness the deployed verifier
// rejects.
//
// Covered: the tag table, the empty-subtree ladder, key derivation, note
// commitments, nullifiers, output rho, value commitments, leaf hashing, the
// quaternary Merkle tree, FMD clue derivation, the PolyEval coefficient
// layout, Fiat-Shamir z, and the full witness built by `toCircomInput` — at
// every shape in `TRANSACT_SHAPES`.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { keccak256, toBytes } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import { bitAt } from "../core/bits.js";
import { BABYJUB_SUBGROUP_ORDER, BN254_FR } from "../core/field.js";
import { coeffCount, shapeId, TRANSACT_SHAPES } from "../core/shape.js";
import {
    buildNoteCommitment,
    buildNullifierFromNsk,
    buildRho,
    deriveIvk,
    deriveNk,
    derivePk,
    type Field,
    H_BASE,
    type Jubjub,
    MerkleTree,
    type Point,
    Poseidon,
    TAG_ASSET,
    TAG_CM,
    TAG_DK,
    TAG_FMD_BIT,
    TAG_IVK,
    TAG_LEAF,
    TAG_MERKLE,
    TAG_NF,
    TAG_NK,
    TAG_PK,
    TAG_RHO,
} from "../crypto/index.js";
import { loadWasmJubjub, wasmDescribe } from "../crypto/wasm-test-utils.js";
import { fmdFlag, fmdFlagKeyFromDetection } from "../fmd/index.js";
import { fiatShamirZ, flatten, hornerEval } from "./compression.js";
import { toCircomInput } from "./input.js";

// ── vector schema ────────────────────────────────────────────────────────

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
    coeffCount: number;
    layout: string[];
    layoutDigest: string;
}

interface Constants {
    bn254Fr: string;
    babyjubSubgroupOrder: string;
    babyjubBase8: PointJson;
    hBase: PointJson;
    tags: Record<string, string>;
    emptySubtree: string[];
}

interface TransactWitness {
    z: string;
    merkle_root: string;
    nullifier: string[];
    out_cm: string[];
    public_asset_id: string;
    public_in: string;
    public_out: string;
    in_cv: string[][];
    out_cv: string[][];
    recipient_address: string;
    chain_id: string;
    payer_address: string;
    relayer_address: string;
    out_cv_dep: string[][];
    in_asset: string[];
    in_value: string[];
    in_pk: string[];
    in_rho: string[];
    in_rcm: string[];
    in_nsk: string[];
    in_rcv: string[];
    in_rcv_dep: string[];
    in_path_elements: string[][][];
    in_path_indices: string[][];
    in_is_dummy: string[];
    out_asset: string[];
    out_value: string[];
    out_pk: string[];
    out_rho: string[];
    out_rcm: string[];
    out_rcv: string[];
    out_rcv_dep: string[];
    out_clue_bits: string[];
    out_clue_Rx: string[];
    out_clue_Ry: string[];
    out_aux_digest: string;
}

interface Compression {
    coeffs: string[];
    z: string;
    y: string;
}

interface TransactVector {
    name: string;
    expect: string;
    intermediates: {
        keys: { nsk: string; ivk: string; nk: string; pk: string }[];
        assetGens: { assetId: string; gen: PointJson }[];
        inputs: {
            slot: number;
            isDummy: boolean;
            cm: string;
            nf: string;
            cv: PointJson;
            cvDep: PointJson;
            leafIndex: number;
        }[];
        realLeaves: {
            slot: number;
            cm: string;
            cvDep: PointJson;
            leaf: string;
            leafIndex: number;
        }[];
        outputs: { slot: number; rho: string; cm: string; cv: PointJson; cvDep: PointJson }[];
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
                clueRx: string;
                clueRy: string;
                clueBits: string;
            }[];
        };
    };
    witness: TransactWitness;
    compression: Compression;
    circuitOutput: { y: string };
}

interface TreeUpdateVector {
    name: string;
    intermediates: {
        startIndex: number;
        actualCount: number;
        oldRoot: string;
        newRoot: string;
        frontierIn: string[][];
        leaves: {
            slot: number;
            cm: string;
            cvDep: PointJson;
            leafHash: string;
            leafAsset: string;
            leafPublicIn: string;
            isDeposit: number;
            rcv: string;
        }[];
    };
    compression: Compression;
    circuitOutput: { y: string };
}

interface VectorFile<V> {
    schema: string;
    circuit: CircuitMeta;
    constants: Constants;
    vectors: V[];
}

// ── loading ──────────────────────────────────────────────────────────────

// `@lelantos-org/circuits/vectors` resolves to the package's `vectors/index.json`;
// the per-circuit files sit beside it and are exported individually. Resolving
// through the package, rather than a relative path, keeps the installed
// package the single source.
//
// The package lives on GitHub Packages, so installing it needs a token with
// `read:packages` — see the `NODE_AUTH_TOKEN` env in `.github/workflows/ci.yml`.
// Without it this suite throws at import rather than skipping, so the parity
// check cannot go silently absent.
const require_ = createRequire(import.meta.url);
const VECTOR_DIR = new URL(".", pathToFileURL(require_.resolve("@lelantos-org/circuits/vectors")));

function readVectorFile(name: string): Uint8Array {
    return new Uint8Array(readFileSync(new URL(name, VECTOR_DIR)));
}

function loadJson<T>(name: string): T {
    return JSON.parse(new TextDecoder().decode(readVectorFile(name))) as T;
}

const index = loadJson<VectorIndex>("index.json");

// The batch vector is named for the circuit's `MAX_L`, which is not part of
// `CircuitShape` — it tracks the batch circuit, not the transact arity. Read the
// name out of the index rather than hardcoding it, so a widened batch is a
// failing assertion here rather than an ENOENT at import time.
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

// Driven off `TRANSACT_SHAPES` rather than a hand-written list, so a shape the
// SDK knows about but the package does not publish a vector file for fails
// loudly at load time instead of going quietly uncovered.
const TRANSACT: readonly TransactSet[] = TRANSACT_SHAPES.map((shape) => {
    const id = shapeId(shape);
    return { id, file: loadJson<VectorFile<TransactVector>>(`transact-${id}.json`) };
});

// The constants block is byte-identical across every file — `every vector file
// agrees on the constants` below is what proves it — so one file stands in for
// all of them wherever a test needs a constant rather than a witness.
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

// The vectors are the contract, so a missing slot is a broken vector file
// rather than a soft failure: `f` says so instead of decoding `undefined`.
const f = (s: string | undefined): Field => {
    if (s === undefined) throw new Error("vector file: missing field element");
    return BigInt(s);
};
const pt = (p: PointJson | undefined): Point => {
    if (p === undefined) throw new Error("vector file: missing point");
    return [BigInt(p.x), BigInt(p.y)];
};

// ── the installed vector set ─────────────────────────────────────────────

const CIRCUITS_PKG = "@lelantos-org/circuits";

describe("installed circuit vectors", () => {
    it("matches the sha256 digests recorded in index.json", () => {
        for (const [name, meta] of Object.entries(index.files)) {
            const got = createHash("sha256").update(readVectorFile(name)).digest("hex");
            expect(got, name).toBe(meta.sha256);
        }
    });

    // The witness layout is a consensus contract, so the vectors must come from
    // the exact circuits release the SDK declares as its peer — a stale install
    // or a one-sided version bump fails here rather than at the verifier. Both
    // ranges are exact pins for the same reason.
    it("was generated by the pinned @lelantos-org/circuits version", () => {
        const pinned = pkg.peerDependencies[CIRCUITS_PKG];
        expect(pkg.devDependencies[CIRCUITS_PKG]).toBe(pinned);
        expect(index.generator).toBe(`${CIRCUITS_PKG}@${pinned}`);
    });

    it("carries the schema this suite parses", () => {
        expect(index.schema).toBe("lelantos.circuits.vectors/1");
        for (const file of ALL_FILES) {
            expect(file.schema).toBe(index.schema);
        }
    });
});

// ── PolyEval layout ──────────────────────────────────────────────────────

// Slot labels in the order `flatten` emits coefficients. The circuits repo
// dumps the same list from its Lean model and hashes it into `layoutDigest`;
// reproducing the digest here proves the two orderings agree name-for-name,
// not merely in length.
function slotLabels(nIn: number, nOut: number): string[] {
    const labels = ["merkleRoot"];
    for (let i = 0; i < nIn; i++) labels.push(`nullifier ${i}`);
    for (let j = 0; j < nOut; j++) labels.push(`outCm ${j}`);
    labels.push("publicAssetId", "publicIn", "publicOut");
    for (let i = 0; i < nIn; i++) labels.push(`inCvX ${i}`, `inCvY ${i}`);
    for (let j = 0; j < nOut; j++) labels.push(`outCvX ${j}`, `outCvY ${j}`);
    labels.push("recipient", "chainId", "payer", "relayer");
    for (let j = 0; j < nOut; j++) labels.push(`outCvDepX ${j}`, `outCvDepY ${j}`);
    for (let j = 0; j < nOut; j++) labels.push(`clueRx ${j}`, `clueRy ${j}`, `clueBits ${j}`);
    labels.push("auxDigest");
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

    it("emits 9 + 3·N_IN + 8·N_OUT coefficients", () => {
        // `coeffCount` in core/shape.ts must reproduce what the package publishes.
        expect(file.circuit.coeffCount).toBe(coeffCount({ nIn, nOut }));
        expect(flatten(file.vectors[0]!.witness)).toHaveLength(file.circuit.coeffCount);
    });
});

// ── consensus constants ──────────────────────────────────────────────────

describe("consensus constants", () => {
    const c = BASELINE.constants;

    it("shares the field moduli", () => {
        expect(BN254_FR).toBe(f(c.bn254Fr));
        expect(BABYJUB_SUBGROUP_ORDER).toBe(f(c.babyjubSubgroupOrder));
    });

    it("shares the value-commitment blinding base H", () => {
        expect(H_BASE).toEqual(pt(c.hBase));
    });

    it("shares the domain-separation tag table", () => {
        expect({
            TAG_CM,
            TAG_NF,
            TAG_PK,
            TAG_IVK,
            TAG_MERKLE,
            TAG_DK,
            TAG_ASSET,
            TAG_FMD_BIT,
            TAG_NK,
            TAG_LEAF,
            TAG_RHO,
        }).toEqual(Object.fromEntries(Object.entries(c.tags).map(([k, v]) => [k, f(v)])));
    });

    it("every vector file agrees on the constants", () => {
        for (const file of ALL_FILES) {
            expect(file.constants).toEqual(c);
        }
    });

    // The circuit tabulates this ladder as literals (constant-folding Poseidon
    // is not something circom does); the SDK recomputes it in MerkleTree's
    // constructor. An empty tree of depth d must land on entry d.
    it("shares the empty-subtree hash ladder", async () => {
        const P = await Poseidon.build();
        for (let depth = 1; depth < c.emptySubtree.length; depth++) {
            expect(new MerkleTree(P, depth).root(), `depth ${depth}`).toBe(
                f(c.emptySubtree[depth]),
            );
        }
    });
});

// ── transact vectors ─────────────────────────────────────────────────────

wasmDescribe("transact vectors", () => {
    let P: Poseidon;
    let J: Jubjub;

    beforeAll(async () => {
        P = await Poseidon.build();
        J = await loadWasmJubjub();
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
                            expect(derivePk(P, nsk)).toBe(f(k.pk));
                        }
                    });

                    it("derives the per-asset generators", () => {
                        for (const a of im.assetGens) {
                            expect(J.hashToAssetGen(f(a.assetId))).toEqual(pt(a.gen));
                        }
                    });

                    it("rebuilds every spent note", () => {
                        im.inputs.forEach((slot, i) => {
                            const note = {
                                asset: f(w.in_asset[i]),
                                value: f(w.in_value[i]),
                                pk: f(w.in_pk[i]),
                                rho: f(w.in_rho[i]),
                                rcm: f(w.in_rcm[i]),
                            };
                            const cm = buildNoteCommitment(P, note);
                            expect(cm, `cm ${i}`).toBe(f(slot.cm));
                            expect(buildNullifierFromNsk(P, f(w.in_nsk[i]), note.rho, cm)).toBe(
                                f(slot.nf),
                            );
                            const gen = J.hashToAssetGen(note.asset);
                            expect(J.valueCommit(note.value, gen, f(w.in_rcv[i]))).toEqual(
                                pt(slot.cv),
                            );
                            expect(J.valueCommit(note.value, gen, f(w.in_rcv_dep[i]))).toEqual(
                                pt(slot.cvDep),
                            );
                        });
                    });

                    it("rebuilds every output note", () => {
                        im.outputs.forEach((slot, j) => {
                            // Output rho is bound to the first input nullifier
                            // and the slot index — the faerie-gold defense.
                            expect(buildRho(P, f(w.nullifier[0]), j), `rho ${j}`).toBe(f(slot.rho));
                            const note = {
                                asset: f(w.out_asset[j]),
                                value: f(w.out_value[j]),
                                pk: f(w.out_pk[j]),
                                rho: f(w.out_rho[j]),
                                rcm: f(w.out_rcm[j]),
                            };
                            expect(buildNoteCommitment(P, note), `cm ${j}`).toBe(f(slot.cm));
                            const gen = J.hashToAssetGen(note.asset);
                            expect(J.valueCommit(note.value, gen, f(w.out_rcv[j]))).toEqual(
                                pt(slot.cv),
                            );
                            expect(J.valueCommit(note.value, gen, f(w.out_rcv_dep[j]))).toEqual(
                                pt(slot.cvDep),
                            );
                        });
                    });

                    it("hashes leaves as Poseidon(TAG_LEAF, cm, cv_dep_x, cv_dep_y)", () => {
                        for (const leaf of im.realLeaves) {
                            expect(
                                P.hash([TAG_LEAF, f(leaf.cm), f(leaf.cvDep.x), f(leaf.cvDep.y)]),
                            ).toBe(f(leaf.leaf));
                        }
                    });

                    it("rebuilds the Merkle root and the membership proofs", () => {
                        const tree = new MerkleTree(P, im.merkle.depth);
                        tree.bulkInsert(im.merkle.leaves.map(f));
                        expect(tree.root()).toBe(f(im.merkle.root));

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
                            expect(`0x${Buffer.from(clue.R).toString("hex")}`).toBe(
                                out.cluePackedR,
                            );

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
                        }
                    });

                    it("flattens to the circuit's coefficient vector", () => {
                        const coeffs = flatten(w);
                        expect(coeffs).toEqual(v.compression.coeffs.map(f));
                    });

                    it("derives z by Fiat-Shamir over the coefficients", () => {
                        expect(fiatShamirZ(v.compression.coeffs.map(f))).toBe(f(v.compression.z));
                        expect(w.z).toBe(v.compression.z);
                    });

                    // y comes from the compiled circuit's witness, so this is
                    // the check that pins the SDK to the deployed verifier.
                    it("evaluates PolyEval to the circuit's output", () => {
                        const y = hornerEval(v.compression.coeffs.map(f), f(v.compression.z));
                        expect(y).toBe(f(v.circuitOutput.y));
                        expect(y).toBe(f(v.compression.y));
                    });

                    it("rebuilds the whole witness with toCircomInput", () => {
                        const spent = im.inputs.map((slot, i) => ({
                            asset: f(w.in_asset[i]),
                            value: f(w.in_value[i]),
                            pk: f(w.in_pk[i]),
                            rho: f(w.in_rho[i]),
                            rcm: f(w.in_rcm[i]),
                            rcv: f(w.in_rcv[i]),
                            rcvDep: f(w.in_rcv_dep[i]),
                            nsk: f(w.in_nsk[i]),
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
                            rcv: f(w.out_rcv[j]),
                            rcvDep: f(w.out_rcv_dep[j]),
                        }));

                        const built = toCircomInput(P, J, {
                            publicAssetId: f(w.public_asset_id),
                            publicIn: f(w.public_in),
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
                            z: f(w.z),
                            outputAuxDigest: f(w.out_aux_digest),
                        });

                        expect(built).toEqual(w);
                    });
                });
            }
        });
    }
});

// ── tree_update_batch vectors ────────────────────────────────────────────
//
// The SDK does not prove this circuit — the relayer owns its 249 MB zkey — but
// it does build the leaves that go into it and mirrors the tree the circuit
// updates, so those two halves must agree.

wasmDescribe("tree_update_batch vectors", () => {
    let P: Poseidon;
    let J: Jubjub;

    beforeAll(async () => {
        P = await Poseidon.build();
        J = await loadWasmJubjub();
    });

    for (const v of treeUpdate.vectors) {
        describe(v.name, () => {
            const im = v.intermediates;

            it("hashes each batch leaf the way the circuit does", () => {
                for (const leaf of im.leaves) {
                    expect(P.hash([TAG_LEAF, f(leaf.cm), f(leaf.cvDep.x), f(leaf.cvDep.y)])).toBe(
                        f(leaf.leafHash),
                    );
                }
            });

            it("binds cv_dep to (asset, public_in) on deposit leaves", () => {
                for (const leaf of im.leaves.filter((l) => l.isDeposit === 1)) {
                    const gen = J.hashToAssetGen(f(leaf.leafAsset));
                    expect(J.valueCommit(f(leaf.leafPublicIn), gen, f(leaf.rcv))).toEqual(
                        pt(leaf.cvDep),
                    );
                }
            });

            // Batches that start mid-tree carry only a frontier, not the
            // leaves already committed, so the root is reproducible off-chain
            // only from index 0.
            const fromEmpty = im.startIndex === 0;
            it.runIf(fromEmpty)("reproduces old and new roots from an empty tree", () => {
                const tree = new MerkleTree(P, treeUpdate.circuit.shape.depth);
                expect(tree.root()).toBe(f(im.oldRoot));
                expect(tree.frontier()).toEqual(im.frontierIn.map((level) => level.map(f)));
                tree.bulkInsert(im.leaves.slice(0, im.actualCount).map((l) => f(l.leafHash)));
                expect(tree.root()).toBe(f(im.newRoot));
            });

            it("agrees on the Fiat-Shamir challenge and PolyEval output", () => {
                const coeffs = v.compression.coeffs.map(f);
                expect(coeffs).toHaveLength(treeUpdate.circuit.coeffCount);
                expect(fiatShamirZ(coeffs)).toBe(f(v.compression.z));
                expect(hornerEval(coeffs, f(v.compression.z))).toBe(f(v.circuitOutput.y));
            });
        });
    }
});
