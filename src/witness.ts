// Witness builders for the 2x2 MASP circuit. Same source consumed by
// circuit tests (circuits/) and Foundry fixture generators (contracts/),
// so the on-chain view, the prover view, and the in-circuit view stay
// byte-identical.

import {
    buildNoteCommitment,
    buildNullifierFromNsk,
    type Field,
    fmdLegendreWitness,
    type Jubjub,
    type Point,
    type Poseidon,
} from "./crypto/index.js";
import { TAG_FMD_BIT } from "./fmd.js";
import type { Note, SpentNote } from "./notes.js";

export interface SpendableCachedNote {
    note: Note;
    nsk: Field;
    leafIndex: number;
}

/// Path supplied externally (e.g. by the relayer's `/path` endpoint).
/// Caller is responsible for verifying the path against an on-chain
/// `isKnownRoot` before trusting it for spending.
export function toSpentNoteFromPath(
    P: Poseidon,
    cached: SpendableCachedNote,
    pathElements: Field[][],
    pathIndices: number[],
): SpentNote {
    const cm = buildNoteCommitment(P, cached.note);
    const nf = buildNullifierFromNsk(P, cached.nsk, cached.note.rho);
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

export interface OutputClueWitness {
    /// FMD blinding scalar r ∈ Z_q*. R = r·G_8 = (clueRx, clueRy).
    r: Field;
    /// γ recipient flag-key points fk[i] = dk[i]·G_8.
    fk: Point[];
    /// 14-bit packed clueBits, LSB first. First γ bits = 1 - lsb1(Poseidon(...)).
    clueBits: Field;
}

export interface BuildOpts {
    publicAssetId: Field;
    publicIn: Field;
    publicOut: Field;
    inputs: SpentNote[];
    outputs: Note[];
    /// FMD clue witnesses per output. Required: pad/dummy outputs also need
    /// a real (r, fk) — circuit constraints fire unconditionally.
    outputClues: OutputClueWitness[];
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
    // the contract derives this from a transcript over the 26 logical PIs
    // (20 base + 6 clue).
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

    const out_cm = outputs.map((o) => buildNoteCommitment(P, o));

    const in_cv: Point[] = inputs.map((i) =>
        J.valueCommit(i.value, J.hashToAssetGen(i.asset), i.rcv),
    );
    const out_cv: Point[] = outputs.map((o) =>
        J.valueCommit(o.value, J.hashToAssetGen(o.asset), o.rcv),
    );

    // Deposit-anchor cv_dep per output (and per input for spent.circom). Same
    // Pedersen shape as cv but with the rcv_dep blinder so the leaf hash
    // Poseidon(TAG_LEAF, cm, cv_dep_x, cv_dep_y) re-derives consistently from
    // the spender's side.
    const out_cv_dep: Point[] = outputs.map((o) =>
        J.valueCommit(o.value, J.hashToAssetGen(o.asset), o.rcvDep),
    );

    const z = opts.z ?? 1n;

    return {
        z: z.toString(),
        merkle_root: merkleRoot.toString(),
        nullifier: inputs.map((i) => i.nf.toString()),
        out_cm: out_cm.map((c) => c.toString()),
        public_asset_id: publicAssetId.toString(),
        public_in: publicIn.toString(),
        public_out: publicOut.toString(),
        in_cv: in_cv.map((p) => [p[0].toString(), p[1].toString()]),
        out_cv: out_cv.map((p) => [p[0].toString(), p[1].toString()]),
        recipient_address: recipientAddress.toString(),
        chain_id: chainId.toString(),
        payer_address: payerAddress.toString(),
        relayer_address: relayerAddress.toString(),
        out_cv_dep: out_cv_dep.map((p) => [p[0].toString(), p[1].toString()]),

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

        out_r: opts.outputClues.map((c) => c.r.toString()),
        out_fk: opts.outputClues.map((c) => c.fk.map((p) => [p[0].toString(), p[1].toString()])),
        out_clue_bits: opts.outputClues.map((c) => c.clueBits.toString()),
        ...fmdLegendreInputs(P, J, opts.outputClues),
    };
}

// Compute the (bit, y) Legendre witness pair per (output, γ-slot) so the
// in-circuit `HashToBit` gadget has the prover-side data it needs. Mirrors
// the hash layout of `ClueCheck` exactly: Poseidon(TAG_FMD_BIT, R.x, R.y,
// i, S.x, S.y).
function fmdLegendreInputs(
    P: Poseidon,
    J: Jubjub,
    clues: OutputClueWitness[],
): { out_legendre_bit: string[][]; out_legendre_y: string[][] } {
    const bits: string[][] = [];
    const ys: string[][] = [];
    for (const c of clues) {
        const R = J.mulPointEscalar(J.base8, c.r);
        const rowBits: string[] = [];
        const rowYs: string[] = [];
        for (let i = 0; i < c.fk.length; i++) {
            const S = J.mulPointEscalar(c.fk[i], c.r);
            const h = P.hash([TAG_FMD_BIT, R[0], R[1], BigInt(i), S[0], S[1]]);
            const w = fmdLegendreWitness(h);
            rowBits.push(w.bit.toString());
            rowYs.push(w.y.toString());
        }
        bits.push(rowBits);
        ys.push(rowYs);
    }
    return { out_legendre_bit: bits, out_legendre_y: ys };
}

export function dummyOutput(asset: Field = 1n): Note {
    return { asset, value: 0n, pk: 0n, rho: 0n, rcm: 0n, rcv: 0n, rcvDep: 0n };
}

// Dummy spent slot. is_dummy=1 bypasses Merkle membership and pk check inside
// the circuit. nf is computed normally as Poseidon(TAG_NF, nk, rho) where
// nk = Poseidon(TAG_NK, 0); pick a fresh `rho` to keep nf distinct from
// prior dummies and any real spend.
export function dummyInputAt(P: Poseidon, depth: number, rho: Field = 0n): SpentNote {
    const nsk = 0n;
    const nf = buildNullifierFromNsk(P, nsk, rho);
    const pathElements: Field[][] = [];
    for (let i = 0; i < depth; i++) pathElements.push([0n, 0n, 0n]);
    return {
        asset: 0n,
        value: 0n,
        pk: 0n,
        rho,
        rcm: 0n,
        rcv: 0n,
        rcvDep: 0n,
        nsk,
        cm: 0n,
        nf,
        leafIndex: 0,
        pathElements,
        pathIndices: new Array(depth).fill(0),
        isDummy: true,
    };
}
