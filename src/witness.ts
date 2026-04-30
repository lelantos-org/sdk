// Witness builders for the 2x2 MASP circuit. Same source consumed by
// circuit tests (circuits/) and Foundry fixture generators (contracts/),
// so the on-chain view, the prover view, and the in-circuit view stay
// byte-identical.

import {
    type Poseidon,
    type Jubjub,
    type MerkleTree,
    buildNoteCommitment,
    buildNullifier,
    type Field,
    type Point,
} from "./crypto/index";
import type { Note, SpentNote } from "./notes";

export interface SpendableCachedNote {
    note: Note;
    nsk: Field;
    leafIndex: number;
}

/// Wallet-cached note + local merkle tree → SpentNote ready for the witness.
/// Use when the wallet already has the canonical tree (tests / e2e).
export function toSpentNote(P: Poseidon, cached: SpendableCachedNote, tree: MerkleTree): SpentNote {
    const proof = tree.proof(cached.leafIndex);
    return toSpentNoteFromPath(P, cached, proof.pathElements, proof.pathIndices);
}

/// Same shape, but path was supplied externally (e.g. by the relayer's
/// `/path` endpoint). Caller is responsible for verifying the path against
/// an on-chain `isKnownRoot` before trusting it for spending.
export function toSpentNoteFromPath(
    P: Poseidon,
    cached: SpendableCachedNote,
    pathElements: Field[][],
    pathIndices: number[],
): SpentNote {
    const cm = buildNoteCommitment(P, cached.note);
    const nf = buildNullifier(P, cached.nsk, cached.note.rho);
    return {
        ...cached.note,
        nsk: cached.nsk,
        cm,
        nf,
        leafIndex: cached.leafIndex,
        pathElements,
        pathIndices,
        isDummy: false,
    };
}

export interface BuildOpts {
    publicAssetId: Field;
    publicAssetGen?: Point;
    publicIn: Field;
    publicOut: Field;
    inputs: SpentNote[];
    outputs: Note[];
    merkleRoot: Field;
    recipientAddress?: Field;
    chainId?: Field;
    /// Pulled by `transferFrom` on deposit. Bound in SNARK so the relayer
    /// cannot redirect token sources. Defaults to 0n for tests where token
    /// movement is not exercised.
    payerAddress?: Field;
    /// Must equal `msg.sender` of the on-chain `transact` call. Bound in
    /// SNARK to prevent front-running by other relayers.
    relayerAddress?: Field;
    // SnarkCompression Fiat-Shamir challenge. Tests default to 1n; in prod
    // the contract derives this from a transcript over the 22 logical PIs.
    z?: Field;
}

export function toCircomInput(
    P: Poseidon,
    J: Jubjub,
    opts: BuildOpts,
): Record<string, string | string[] | string[][] | string[][][]> {
    const { inputs, outputs, publicAssetId, publicIn, publicOut, merkleRoot } = opts;
    const N_IN = 2;
    const N_OUT = 2;
    if (inputs.length !== N_IN) throw new Error("need 2 inputs");
    if (outputs.length !== N_OUT) throw new Error("need 2 outputs");

    const recipientAddress = opts.recipientAddress ?? 0n;
    const chainId = opts.chainId ?? 0n;
    const payerAddress = opts.payerAddress ?? 0n;
    const relayerAddress = opts.relayerAddress ?? 0n;
    const pubGen = opts.publicAssetGen ?? J.hashToAssetGen(publicAssetId);

    const out_cm = outputs.map((o) => buildNoteCommitment(P, o));

    const in_cv: Point[] = inputs.map((i) =>
        J.valueCommit(i.value, J.hashToAssetGen(i.asset), i.rcv),
    );
    const out_cv: Point[] = outputs.map((o) =>
        J.valueCommit(o.value, J.hashToAssetGen(o.asset), o.rcv),
    );

    const z = opts.z ?? 1n;

    return {
        z: z.toString(),
        merkle_root: merkleRoot.toString(),
        nullifier: inputs.map((i) => i.nf.toString()),
        out_cm: out_cm.map((c) => c.toString()),
        public_asset_id: publicAssetId.toString(),
        pub_asset_gen_x: pubGen[0].toString(),
        pub_asset_gen_y: pubGen[1].toString(),
        public_in: publicIn.toString(),
        public_out: publicOut.toString(),
        in_cv: in_cv.map((p) => [p[0].toString(), p[1].toString()]),
        out_cv: out_cv.map((p) => [p[0].toString(), p[1].toString()]),
        recipient_address: recipientAddress.toString(),
        chain_id: chainId.toString(),
        payer_address: payerAddress.toString(),
        relayer_address: relayerAddress.toString(),

        in_asset: inputs.map((i) => i.asset.toString()),
        in_value: inputs.map((i) => i.value.toString()),
        in_pk: inputs.map((i) => i.pk.toString()),
        in_rho: inputs.map((i) => i.rho.toString()),
        in_rcm: inputs.map((i) => i.rcm.toString()),
        in_nsk: inputs.map((i) => i.nsk.toString()),
        in_rcv: inputs.map((i) => i.rcv.toString()),
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
    };
}

export function dummyOutput(asset: Field = 1n): Note {
    return { asset, value: 0n, pk: 0n, rho: 0n, rcm: 0n, rcv: 0n };
}

// Dummy spent slot. is_dummy=1 bypasses Merkle membership and pk check inside
// the circuit. nf is computed normally as Poseidon(TAG_NF, 0, rho); pick a
// fresh `rho` to keep nf distinct from prior dummies and any real spend.
export function dummyInputAt(P: Poseidon, depth: number, rho: Field = 0n): SpentNote {
    const nsk = 0n;
    const nf = buildNullifier(P, nsk, rho);
    const pathElements: Field[][] = [];
    for (let i = 0; i < depth; i++) pathElements.push([0n, 0n, 0n]);
    return {
        asset: 0n,
        value: 0n,
        pk: 0n,
        rho,
        rcm: 0n,
        rcv: 0n,
        nsk,
        cm: 0n,
        nf,
        leafIndex: 0,
        pathElements,
        pathIndices: new Array(depth).fill(0),
        isDummy: true,
    };
}
