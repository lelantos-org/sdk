// Deposit request builder. Does not prove; deposits go through
// `MASP.deposit` (Permit2 witness). Returns a `BuiltDeposit` the wallet signs
// and broadcasts itself; the relayer serves no deposit route and picks the
// escrow up from the `DepositEscrowed` event.

import { fieldToBytes32 } from "../core/hex.js";
import {
    buildNoteCommitment,
    type Field,
    type Jubjub,
    type Point,
    type Poseidon,
} from "../crypto/index.js";
import type { Note } from "../notes/note.js";
import { auxOutputToWire } from "../protocol/aux-wire.js";
import type { AuxOutput, DepositRequest } from "../protocol/deposit-request.js";
import { buildAuxForReal, type OutputRandomness, type OutputRecipient } from "./common.js";

/** @internal */
export interface DepositArgs {
    P: Poseidon;
    J: Jubjub;
    chainId: bigint;
    asset: bigint;
    /** 0x ETH; payer's account (Permit2 transfer source). */
    payerAddress: string;
    /** 0x ETH; on-chain recipient (binds DepositRequest.recipient). */
    recipientAddress: string;
    publicIn: bigint;
    /**
     * Bech32m-decoded shielded address of the receiving wallet. Provides
     * the note-binding `pk` via the address payload.
     */
    recipient: OutputRecipient;
    /** Randomness for the depositor's output. */
    output0: { rho: Field; rcm: Field; rcv: Field; rcvDep: Field; aux: OutputRandomness };
    /**
     * The relayer's fee note: who it pays, how much, in which asset, and its
     * randomness.
     *
     * A deposit always mints two leaves. `value` may be zero on a chain that
     * subsidises deposits; the leaf is still minted so the shape is fixed.
     */
    fee: {
        recipient: OutputRecipient;
        /** Circuit units of `asset`. */
        value: bigint;
        /**
         * Registry id the note is paid in. Defaults to the deposit's `asset`.
         *
         * Ignored for a zero `value`: that note is a self-pad in the deposit
         * asset and the request names asset 0, as the circuit and the pool
         * require of a zero-value leaf.
         */
        asset?: bigint | undefined;
        rho: Field;
        rcm: Field;
        rcv: Field;
        rcvDep: Field;
        aux: OutputRandomness;
    };
}

/** @internal */
export interface BuiltDeposit {
    /**
     * Plaintext DepositRequest — the wallet hashes this with `aux` to derive
     * the Permit2 witness `piHash`, then signs the Permit2 typed-data.
     */
    deposit: DepositRequest;
    /** FMD clue + ECDH + ciphertext for the output. Bound into `piHash`. */
    aux: AuxOutput;
    /** The same, for the relayer's fee note. Also bound into `piHash`. */
    feeAux: AuxOutput;
    cm: Field;
    /**
     * Only the depositor's note. The fee note belongs to the relayer and is
     * excluded so the wallet balance does not include value it cannot spend.
     */
    producedNotes: [Note];
}

export function buildDeposit(a: DepositArgs): BuiltDeposit {
    const { P, J } = a;
    const assetGen = J.hashToAssetGen(a.asset);

    // One leaf: the note, its encrypted payload, its commitment, and its deposit-anchor Pedersen
    // value commitment `cv_dep = value · V^asset + rcv_dep · H`. `cv_dep` is baked into the leaf
    // via Poseidon(TAG_LEAF, cm, cv_dep), so the spender cannot open `cm` under a different
    // (asset, value) at spend time.
    const leaf = (
        asset: bigint,
        value: bigint,
        recipient: OutputRecipient,
        r: DepositArgs["output0"],
    ): { note: Note; aux: AuxOutput; cm: Field; cvDep: Point } => {
        const { rho, rcm, rcv, rcvDep } = r;
        const note: Note = { asset, value, pk: recipient.pk, rho, rcm, rcv, rcvDep };
        const gen = asset === a.asset ? assetGen : J.hashToAssetGen(asset);
        return {
            note,
            aux: auxOutputToWire(buildAuxForReal(J, P, note, recipient, r.aux).aux),
            cm: buildNoteCommitment(P, note),
            cvDep: J.valueCommit(value, gen, r.rcvDep),
        };
    };

    const out = leaf(a.asset, a.publicIn, a.recipient, a.output0);
    // The relayer's leaf, built like the depositor's: its own asset, value and
    // blinders, addressed to the relayer's shielded address. The batch circuit
    // binds each leaf's `cvDep` to its own `(value, asset)` independently,
    // which lets one deposit carry both, in the same asset or not.
    //
    // A zero-value note stays in the deposit asset. `cvDep = 0 · V + rcvDep · H`
    // does not depend on the asset, and scanners discard it as a self-pad; only
    // the request's `feeAssetId` must be 0 for it.
    const feeAsset = a.fee.value === 0n ? a.asset : (a.fee.asset ?? a.asset);
    const fee = leaf(feeAsset, a.fee.value, a.fee.recipient, a.fee);

    const deposit: DepositRequest = {
        chainId: a.chainId,
        publicAssetId: a.asset,
        publicIn: a.publicIn,
        payer: a.payerAddress,
        recipient: a.recipientAddress,
        outCm: fieldToBytes32(out.cm),
        cvDep: [out.cvDep[0], out.cvDep[1]],
        rcv: out.note.rcvDep,
        feeAssetId: a.fee.value === 0n ? 0n : feeAsset,
        feeIn: a.fee.value,
        feeCm: fieldToBytes32(fee.cm),
        feeCvDep: [fee.cvDep[0], fee.cvDep[1]],
        feeRcv: fee.note.rcvDep,
    };

    return { deposit, aux: out.aux, feeAux: fee.aux, cm: out.cm, producedNotes: [out.note] };
}
