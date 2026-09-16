// The transact circuit witness. Shape-agnostic: the arity is read off the
// input arrays; 4×6 is the deployed instance.
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
import { InvalidArgumentError } from "../errors/config.js";
import type { OutputAuxWithWitness } from "../notes/aux.js";
import type { Note, SpentNote } from "../notes/note.js";

/**
 * The public-input slots the circuit evaluates: `TransactCompressN`'s
 * coefficients, in `PubInputs.compress(Transact)` order.
 *
 * Every one is pinned by a constraint elsewhere in `4x6.circom`: the root by
 * Merkle membership, the nullifiers and commitments by Poseidon, the value
 * commitments by `ValueCommit`, the public scalars by `RangeCheck64` and the
 * balance. Being pinned is the membership rule; see `coeffCount` in
 * `protocol/shape.ts`.
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
 * `4x6.circom` constrains none of them, so as PolyEval coefficients they would
 * be free variables a prover could solve `y = Σ c[k]·z^k` with after reading
 * `z`. They are bound through the challenge instead: `PubInputs.compress`
 * hashes them into `z`, so a relayer that rewrites one produces a different
 * challenge and the proof no longer matches. This binding costs no constraint.
 */
export interface TransactBinding {
    recipient_address: string;
    chain_id: string;
    payer_address: string;
    relayer_address: string;
    /**
     * Commitment to what the spend's funds are used for. `SwapWrapper.swap`
     * requires the swap intent's hash; zero for every other spend.
     */
    intent_hash: string;
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
    /**
     * `PubInputs.Transact.intentHash`: for a swap's withdraw leg,
     * `swapIntentHash` over the swap's output, floor, venue, deadline and
     * refund owner, which `SwapWrapper.swap` recomputes. Bound through the
     * challenge so whoever submits the swap cannot change them. Ignored by
     * every other spend; defaults to 0n.
     */
    intentHash?: Field;
    // SnarkCompression Fiat-Shamir challenge. Tests default to 1n; in prod
    // the contract derives it from a transcript over the logical PIs.
    z?: Field;
    /**
     * `auxDigest(aux)` over the outputs' encrypted-note payloads. Required
     * rather than defaulted: the contract always recomputes this slot from
     * calldata, so a default of 0 would build a witness the verifier rejects.
     * See `auxDigest` in `protocol/abi-hash.ts`.
     */
    outputAuxDigest: Field;
}

/**
 * What a builder produces: the circuit's witness plus the binding fields that
 * only reach the challenge.
 *
 * One object because consumers need both (`flatten` to derive `z`, the prover
 * to prove), and splitting them would make it possible to hash one transaction
 * and prove another. `circuitSignals` projects it before the witness
 * calculator, which rejects keys the circuit does not declare.
 */
export type TransactWitnessBundle = CircomTransactInput & TransactBinding;

/**
 * Project a bundle onto the circuit's signal set.
 *
 * An explicit pick, not a delete list: a circuit signal missing here fails to
 * compile instead of being defaulted.
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
    // deployed circuit is 4×6; `protocol/shape.ts` describes the shapes.
    if (inputs.length === 0) {
        throw new InvalidArgumentError("need at least one input slot", { argument: "inputs" });
    }
    if (outputs.length === 0) {
        throw new InvalidArgumentError("need at least one output slot", { argument: "outputs" });
    }
    if (opts.outputClues.length !== outputs.length) {
        throw new InvalidArgumentError(
            `outputClues has ${opts.outputClues.length} entries, expected ${outputs.length}`,
            { argument: "outputClues" },
        );
    }

    const recipientAddress = opts.recipientAddress ?? 0n;
    const chainId = opts.chainId ?? 0n;
    const payerAddress = opts.payerAddress ?? 0n;
    const relayerAddress = opts.relayerAddress ?? 0n;
    const intentHash = opts.intentHash ?? 0n;

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
    // Decimal strings of one field across every item, and of each point's coordinates.
    const col = <T, K extends keyof T>(items: readonly T[], key: K) =>
        items.map((item) => String(item[key]));
    const points = (ps: readonly Point[]) => ps.map((p) => p.map(String));

    return {
        z: z.toString(),
        merkle_root: merkleRoot.toString(),
        nullifier: col(inputs, "nf"),
        out_cm: outCm.map(String),
        public_asset_id: publicAssetId.toString(),
        public_in: publicIn.toString(),
        public_out: publicOut.toString(),
        in_cv: points(inCv),
        out_cv: points(outCv),
        recipient_address: recipientAddress.toString(),
        chain_id: chainId.toString(),
        payer_address: payerAddress.toString(),
        relayer_address: relayerAddress.toString(),
        intent_hash: intentHash.toString(),
        out_cv_dep: points(outCvDep),

        in_asset: col(inputs, "asset"),
        in_value: col(inputs, "value"),
        in_pk: col(inputs, "pk"),
        in_rho: col(inputs, "rho"),
        in_rcm: col(inputs, "rcm"),
        in_nsk: col(inputs, "nsk"),
        in_rcv: col(inputs, "rcv"),
        in_rcv_dep: col(inputs, "rcvDep"),
        in_path_elements: inputs.map((i) => i.pathElements.map((level) => level.map(String))),
        in_path_indices: inputs.map((i) => i.pathIndices.map(String)),
        in_is_dummy: inputs.map((i) => (i.isDummy ? "1" : "0")),

        out_asset: col(outputs, "asset"),
        out_value: col(outputs, "value"),
        out_pk: col(outputs, "pk"),
        out_rho: col(outputs, "rho"),
        out_rcm: col(outputs, "rcm"),
        out_rcv: col(outputs, "rcv"),
        out_rcv_dep: col(outputs, "rcvDep"),

        out_clue_bits: col(opts.outputClues, "clueBits"),
        out_clue_Rx: col(opts.outputClues, "clueRx"),
        out_clue_Ry: col(opts.outputClues, "clueRy"),

        out_aux_digest: opts.outputAuxDigest.toString(),
    };
}
