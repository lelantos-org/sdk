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

/** Public-input slots, in `PubInputs.compress(Transact)` order. */
export interface CircomPublicInputs {
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
    /**
     * Per-output Pedersen value commitment anchoring (asset, value) into the
     * Merkle leaf. Circuit slots 20..23.
     */
    out_cv_dep: string[][];
    /** Per-output FMD clue PIs. Circuit slots 24..29. */
    out_clue_Rx: string[];
    out_clue_Ry: string[];
    out_clue_bits: string[];
    /** Digest over the encrypted-note payloads; final slot. */
    out_aux_digest: string;
}

/** Full witness: the public slots above plus the private ones. */
export interface CircomTransactInput extends CircomPublicInputs {
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

export function toCircomInput(P: Poseidon, J: Jubjub, opts: BuildOpts): CircomTransactInput {
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
