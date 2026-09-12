// The transact circuit witness. Shape-agnostic: the arity is read off the
// input arrays; 2×2 is the deployed instance.
//
// `CircomTransactInput` is a named interface, shared by `flatten` and
// `extractPubInputs`, so neither needs a cast or a re-parse of the same shape.
//
// Every value is a decimal string: circom reads them positionally, so the
// key set is part of the contract with the circuit.

import {
    buildNoteCommitment,
    type Field,
    type Jubjub,
    type Point,
    type Poseidon,
} from "../crypto/index.js";
import type { OutputAuxWithWitness } from "../notes/aux.js";
import type { Note, SpentNote } from "../notes/note.js";

/**
 * The public-input slots the circuit evaluates: `TransactCompressN`'s
 * coefficients, in `PubInputs.compress(Transact)` order.
 *
 * Every one is pinned by a constraint elsewhere in `4x6.circom` — the root by
 * Merkle membership, the nullifiers and commitments by Poseidon, the value
 * commitments by `ValueCommit`, the public scalars by `RangeCheck64` and the
 * balance. That is the membership rule, not an accident of the layout; see
 * `coeffCount` in `core/shape.ts`.
 */
export interface CircomCoeffInputs {
    merkle_root: string;
    nullifier: string[];
    out_cm: string[];
    public_asset_id: string;
    public_in: string;
    public_out: string;
    in_cv: string[][];
    out_cv: string[][];
    /**
     * Per-output Pedersen value commitment anchoring (asset, value) into the
     * Merkle leaf.
     */
    out_cv_dep: string[][];
}

/**
 * Logical public inputs that are **not** circuit signals.
 *
 * `4x6.circom` constrains none of them, so as PolyEval coefficients they were
 * free variables a prover could solve `y = Σ c[k]·z^k` with after reading `z`.
 * They bind through the challenge instead: `PubInputs.compress` hashes them
 * into `z`, so a relayer that rewrites one hands the verifier a different
 * challenge and the proof stops matching. That binding costs no constraint.
 */
export interface TransactBinding {
    recipient_address: string;
    chain_id: string;
    payer_address: string;
    relayer_address: string;
    /** Per-output FMD clue PIs. */
    out_clue_Rx: string[];
    out_clue_Ry: string[];
    out_clue_bits: string[];
    /** Digest over the encrypted-note payloads. */
    out_aux_digest: string;
}

/** Every logical public input: what `flatten` hashes into the challenge. */
export interface CircomPublicInputs extends CircomCoeffInputs, TransactBinding {}

/** Full witness: the coefficient slots above plus the private ones. */
export interface CircomTransactInput extends CircomCoeffInputs {
    /** Fiat-Shamir challenge over the logical PIs. */
    z: string;

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
}

export interface BuildOpts {
    publicAssetId: Field;
    publicIn: Field;
    publicOut: Field;
    inputs: SpentNote[];
    outputs: Note[];
    outputClues: OutputAuxWithWitness["witness"][];
    merkleRoot: Field;
    recipientAddress?: Field;
    chainId?: Field;
    /**
     * Pulled by `transferFrom` on deposit. Bound in SNARK so the relayer
     * cannot redirect token sources. Defaults to 0n for tests where token
     * movement is not exercised.
     */
    payerAddress?: Field;
    /**
     * Must equal `msg.sender` of the on-chain `transact` call. Bound in
     * SNARK to prevent front-running by other relayers.
     */
    relayerAddress?: Field;
    // SnarkCompression Fiat-Shamir challenge. Tests default to 1n; in prod
    // the contract derives it from a transcript over the logical PIs.
    z?: Field;
    /**
     * `auxDigest(aux)` over the outputs' encrypted-note payloads. Required
     * rather than defaulted: the contract always recomputes this slot from
     * calldata, so a caller that silently passed 0 would build a witness the
     * verifier rejects. See `auxDigest` in `protocol/abi-hash.ts`.
     */
    outputAuxDigest: Field;
}

/**
 * What a builder produces: the circuit's witness plus the binding fields that
 * only reach the challenge.
 *
 * One object because every consumer needs both — `flatten` to derive `z`, the
 * prover to prove — and splitting them at the source would make it easy to hash
 * one transaction and prove another. `circuitSignals` projects it before the
 * witness calculator, which rejects a key the circuit does not declare.
 */
export type TransactWitnessBundle = CircomTransactInput & TransactBinding;

/**
 * Project a bundle onto the circuit's signal set.
 *
 * An explicit pick, not a delete list: a signal added to the circuit and
 * forgotten here fails to compile rather than being silently defaulted.
 */
export function circuitSignals(w: TransactWitnessBundle): CircomTransactInput {
    return {
        z: w.z,
        merkle_root: w.merkle_root,
        nullifier: w.nullifier,
        out_cm: w.out_cm,
        public_asset_id: w.public_asset_id,
        public_in: w.public_in,
        public_out: w.public_out,
        in_cv: w.in_cv,
        out_cv: w.out_cv,
        out_cv_dep: w.out_cv_dep,
        in_asset: w.in_asset,
        in_value: w.in_value,
        in_pk: w.in_pk,
        in_rho: w.in_rho,
        in_rcm: w.in_rcm,
        in_nsk: w.in_nsk,
        in_rcv: w.in_rcv,
        in_rcv_dep: w.in_rcv_dep,
        in_path_elements: w.in_path_elements,
        in_path_indices: w.in_path_indices,
        in_is_dummy: w.in_is_dummy,
        out_asset: w.out_asset,
        out_value: w.out_value,
        out_pk: w.out_pk,
        out_rho: w.out_rho,
        out_rcm: w.out_rcm,
        out_rcv: w.out_rcv,
        out_rcv_dep: w.out_rcv_dep,
    };
}

export function toCircomInput(P: Poseidon, J: Jubjub, opts: BuildOpts): TransactWitnessBundle {
    const { inputs, outputs, publicAssetId, publicIn, publicOut, merkleRoot } = opts;
    // Shape is read off the arrays: the witness layout is identical for every
    // `Transact(DEPTH, N_IN, N_OUT)` instance, and only the zkey pins N. The
    // deployed circuit is 2×2; `core/shape.ts` describes what a wider shape
    // additionally needs.
    if (inputs.length === 0) throw new Error("need at least one input slot");
    if (outputs.length === 0) throw new Error("need at least one output slot");
    if (opts.outputClues.length !== outputs.length) {
        throw new Error(
            `outputClues has ${opts.outputClues.length} entries, expected ${outputs.length}`,
        );
    }

    const recipientAddress = opts.recipientAddress ?? 0n;
    const chainId = opts.chainId ?? 0n;
    const payerAddress = opts.payerAddress ?? 0n;
    const relayerAddress = opts.relayerAddress ?? 0n;

    const outCm = outputs.map((o) => buildNoteCommitment(P, o));
    const inCv: Point[] = inputs.map((i) =>
        J.valueCommit(i.value, J.hashToAssetGen(i.asset), i.rcv),
    );
    const outCv: Point[] = outputs.map((o) =>
        J.valueCommit(o.value, J.hashToAssetGen(o.asset), o.rcv),
    );
    // cv_dep anchors (asset, value, rcv_dep) into the Merkle leaf:
    //   leaf = Poseidon(TAG_LEAF, cm, cv_dep_x, cv_dep_y)
    const outCvDep: Point[] = outputs.map((o) =>
        J.valueCommit(o.value, J.hashToAssetGen(o.asset), o.rcvDep),
    );

    const z = opts.z ?? 1n;

    return {
        z: z.toString(),
        merkle_root: merkleRoot.toString(),
        nullifier: inputs.map((i) => i.nf.toString()),
        out_cm: outCm.map((c) => c.toString()),
        public_asset_id: publicAssetId.toString(),
        public_in: publicIn.toString(),
        public_out: publicOut.toString(),
        in_cv: inCv.map((p) => [p[0].toString(), p[1].toString()]),
        out_cv: outCv.map((p) => [p[0].toString(), p[1].toString()]),
        recipient_address: recipientAddress.toString(),
        chain_id: chainId.toString(),
        payer_address: payerAddress.toString(),
        relayer_address: relayerAddress.toString(),
        out_cv_dep: outCvDep.map((p) => [p[0].toString(), p[1].toString()]),

        in_asset: inputs.map((i) => i.asset.toString()),
        in_value: inputs.map((i) => i.value.toString()),
        in_pk: inputs.map((i) => i.pk.toString()),
        in_rho: inputs.map((i) => i.rho.toString()),
        in_rcm: inputs.map((i) => i.rcm.toString()),
        in_nsk: inputs.map((i) => i.nsk.toString()),
        in_rcv: inputs.map((i) => i.rcv.toString()),
        in_rcv_dep: inputs.map((i) => i.rcvDep.toString()),
        in_path_elements: inputs.map((i) =>
            i.pathElements.map((level) => level.map((e) => e.toString())),
        ),
        in_path_indices: inputs.map((i) => i.pathIndices.map((b) => b.toString())),
        in_is_dummy: inputs.map((i) => (i.isDummy ? "1" : "0")),

        out_asset: outputs.map((o) => o.asset.toString()),
        out_value: outputs.map((o) => o.value.toString()),
        out_pk: outputs.map((o) => o.pk.toString()),
        out_rho: outputs.map((o) => o.rho.toString()),
        out_rcm: outputs.map((o) => o.rcm.toString()),
        out_rcv: outputs.map((o) => o.rcv.toString()),
        out_rcv_dep: outputs.map((o) => o.rcvDep.toString()),

        out_clue_bits: opts.outputClues.map((c) => c.clueBits.toString()),
        out_clue_Rx: opts.outputClues.map((c) => c.clueRx.toString()),
        out_clue_Ry: opts.outputClues.map((c) => c.clueRy.toString()),

        out_aux_digest: opts.outputAuxDigest.toString(),
    };
}
