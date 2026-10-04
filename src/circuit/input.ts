// The transact circuit witness. Shape-agnostic: the arity is read off the input arrays. Every
// value is a decimal string, and the key set is part of the contract with the circuit.

import { buildNoteCommitment, type Field, type Poseidon } from "../crypto/index.js";
import { InvalidArgumentError } from "../errors/config.js";
import type { OutputAuxWithWitness } from "../notes/aux.js";
import type { Note, SpentNote } from "../notes/note.js";
import { transactDigest } from "./compression.js";

/**
 * The public slots that are circuit input signals: `TransactCompressN`'s coefficients, in
 * `PubInputs.compress(Transact)` order. The circuit evaluates them into `y` and computes its
 * `digest` output from them.
 *
 * Each is also constrained outside the compressor: the root by Merkle membership, the nullifiers
 * and commitments by Poseidon, the two public scalars by `RangeCheck64` and the balance.
 */
export interface CircomCoeffInputs {
    merkle_root: string;
    nullifier: string[];
    out_cm: string[];
    /** Zero whenever `public_out` is zero: a transfer names no asset. */
    public_asset_id: string;
    public_out: string;
}

/**
 * Logical public inputs that are not circuit input signals.
 *
 * `digest` is the calldata copy of the coefficient digest. The circuit computes its own from the
 * coefficient signals and exposes it as a public signal, which the verifier compares against
 * this word.
 *
 * The circuit constrains none of the others. `PubInputs.compress` hashes them into `z`, so a
 * relayer that rewrites one changes the challenge and the proof no longer matches.
 */
export interface TransactBinding {
    /** `transactDigest` over the coefficient slots: `PubInputs.Transact.digest`. */
    digest: string;
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

/** The circuit's input signals: `z`, the coefficient slots and the private ones. */
export interface CircomTransactInput extends CircomCoeffInputs {
    /** Fiat-Shamir challenge over the logical PIs. The circuit requires `z != 0`. */
    z: string;

    in_asset: string[];
    in_value: string[];
    in_rho: string[];
    in_rcm: string[];
    in_nsk: string[];
    /**
     * Diversifier per input slot. The circuit derives the slot's owner key as
     * `Poseidon(TAG_PK, ivk, in_d)` and opens the commitment under it, on real and dummy slots
     * alike.
     */
    in_d: string[];
    in_path_elements: string[][][];
    in_path_indices: string[][];
    in_is_dummy: string[];

    out_asset: string[];
    out_value: string[];
    out_pk: string[];
    out_rho: string[];
    out_rcm: string[];
}

export interface BuildOpts {
    /** Must be 0n when `publicOut` is 0n. */
    publicAssetId: Field;
    publicOut: Field;
    inputs: SpentNote[];
    outputs: Note[];
    outputClues: OutputAuxWithWitness["witness"][];
    merkleRoot: Field;
    recipientAddress?: Field;
    chainId?: Field;
    /**
     * Who may drive a satellite that consumes the spend (`SwapWrapper.swap`
     * requires `msg.sender == payer`). Bound through the challenge.
     */
    payerAddress?: Field;
    /**
     * Must equal `msg.sender` of the on-chain `transact` call. Bound through
     * the challenge to prevent front-running by other relayers.
     */
    relayerAddress?: Field;
    /**
     * `PubInputs.Transact.intentHash`: for a swap's withdraw leg, `swapIntentHash` over the
     * swap's output, floor, venue, deadline and refund owner, which `SwapWrapper.swap`
     * recomputes. Bound through the challenge so whoever submits the swap cannot change them.
     * Ignored by every other spend; defaults to 0n.
     */
    intentHash?: Field;
    // Fiat-Shamir challenge; defaults to 1n. The contract derives it from the logical PIs.
    z?: Field;
    /**
     * `auxDigest(aux)` (`protocol/abi-hash.ts`) over the outputs' encrypted-note payloads.
     * Required: the contract recomputes this slot from calldata, so a default of 0 would build a
     * witness the verifier rejects.
     */
    outputAuxDigest: Field;
}

/**
 * The circuit's witness plus the binding fields that only reach the challenge.
 *
 * One object, so `flatten` (to derive `z`) and the prover cannot be handed different
 * transactions. `circuitSignals` projects it before the witness calculator, which rejects keys
 * the circuit does not declare.
 */
export type TransactWitnessBundle = CircomTransactInput & TransactBinding;

/**
 * Project a bundle onto the circuit's input-signal set. Each key is picked explicitly, so a
 * signal missing here is a type error. `digest` is a circuit output and is not passed.
 */
export function circuitSignals(w: TransactWitnessBundle): CircomTransactInput {
    return {
        z: w.z,
        merkle_root: w.merkle_root,
        nullifier: w.nullifier,
        out_cm: w.out_cm,
        public_asset_id: w.public_asset_id,
        public_out: w.public_out,
        in_asset: w.in_asset,
        in_value: w.in_value,
        in_rho: w.in_rho,
        in_rcm: w.in_rcm,
        in_nsk: w.in_nsk,
        in_d: w.in_d,
        in_path_elements: w.in_path_elements,
        in_path_indices: w.in_path_indices,
        in_is_dummy: w.in_is_dummy,
        out_asset: w.out_asset,
        out_value: w.out_value,
        out_pk: w.out_pk,
        out_rho: w.out_rho,
        out_rcm: w.out_rcm,
    };
}

export function toCircomInput(P: Poseidon, opts: BuildOpts): TransactWitnessBundle {
    const { inputs, outputs, publicAssetId, publicOut, merkleRoot } = opts;
    // The witness layout is identical for every `Transact(DEPTH, N_IN, N_OUT)` instance; only
    // the zkey pins the arity. `protocol/shape.ts` lists the shapes.
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
    // The circuit constrains `public_out == 0 ⇒ public_asset_id == 0`, and the
    // pool reverts `MustNotNameAsset` on a transfer that names one.
    if (publicOut === 0n && publicAssetId !== 0n) {
        throw new InvalidArgumentError("publicAssetId must be 0 when publicOut is 0", {
            argument: "publicAssetId",
        });
    }

    const recipientAddress = opts.recipientAddress ?? 0n;
    const chainId = opts.chainId ?? 0n;
    const payerAddress = opts.payerAddress ?? 0n;
    const relayerAddress = opts.relayerAddress ?? 0n;
    const intentHash = opts.intentHash ?? 0n;

    const z = opts.z ?? 1n;
    // Decimal strings of one field across every item.
    const col = <T, K extends keyof T>(items: readonly T[], key: K) =>
        items.map((item) => String(item[key]));

    const coeffSignals: CircomCoeffInputs = {
        merkle_root: merkleRoot.toString(),
        nullifier: col(inputs, "nf"),
        out_cm: outputs.map((o) => buildNoteCommitment(P, o).toString()),
        public_asset_id: publicAssetId.toString(),
        public_out: publicOut.toString(),
    };

    return {
        z: z.toString(),
        ...coeffSignals,
        digest: transactDigest(coeffSignals).toString(),
        recipient_address: recipientAddress.toString(),
        chain_id: chainId.toString(),
        payer_address: payerAddress.toString(),
        relayer_address: relayerAddress.toString(),
        intent_hash: intentHash.toString(),

        in_asset: col(inputs, "asset"),
        in_value: col(inputs, "value"),
        in_rho: col(inputs, "rho"),
        in_rcm: col(inputs, "rcm"),
        in_nsk: col(inputs, "nsk"),
        in_d: col(inputs, "d"),
        in_path_elements: inputs.map((i) => i.pathElements.map((level) => level.map(String))),
        in_path_indices: inputs.map((i) => i.pathIndices.map(String)),
        in_is_dummy: inputs.map((i) => (i.isDummy ? "1" : "0")),

        out_asset: col(outputs, "asset"),
        out_value: col(outputs, "value"),
        out_pk: col(outputs, "pk"),
        out_rho: col(outputs, "rho"),
        out_rcm: col(outputs, "rcm"),

        out_clue_bits: col(opts.outputClues, "clueBits"),
        out_clue_Rx: col(opts.outputClues, "clueRx"),
        out_clue_Ry: col(opts.outputClues, "clueRy"),

        out_aux_digest: opts.outputAuxDigest.toString(),
    };
}
