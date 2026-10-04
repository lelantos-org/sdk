// Deposit request builder. Does not prove: deposits go through `MASP.deposit` (Permit2
// witness). Returns a `BuiltDeposit` the wallet signs and broadcasts; the relayer serves no
// deposit route and picks the escrow up from the `DepositEscrowed` event.

import { fieldToBytes32 } from "../core/hex.js";
import {
    buildInner,
    commitWithInner,
    type Field,
    type Jubjub,
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
    /** Decoded shielded address of the receiving wallet; supplies the note-binding `pk`. */
    recipient: OutputRecipient;
    /**
     * Randomness for the depositor's output. `rcm` is the only secret in the published
     * `inner`, so it must be uniform.
     */
    output0: { rho: Field; rcm: Field; aux: OutputRandomness };
    /**
     * The relayer's fee note. A deposit always mints two leaves: `value` may be zero on a
     * chain that subsidises deposits, and the leaf is still minted so the shape is fixed.
     */
    fee: {
        recipient: OutputRecipient;
        /** Circuit units of `asset`. */
        value: bigint;
        /**
         * Registry id the note is paid in. Defaults to the deposit's `asset`. Ignored for a
         * zero `value`: that note and the request both name asset 0, as the pool requires of a
         * zero-value fee leaf.
         */
        asset?: bigint | undefined;
        rho: Field;
        rcm: Field;
        aux: OutputRandomness;
    };
}

/** @internal */
export interface BuiltDeposit {
    /**
     * Plaintext `DepositRequest`. The wallet hashes it with `aux` into the Permit2 witness
     * `piHash`, then signs the Permit2 typed data.
     */
    deposit: DepositRequest;
    /** FMD clue + ECDH + ciphertext for the output. Bound into `piHash`. */
    aux: AuxOutput;
    /** The same, for the relayer's fee note. Also bound into `piHash`. */
    feeAux: AuxOutput;
    /**
     * The depositor's leaf. Not in the request or the event, which carry `inner`: the batch
     * circuit builds this from it and the public amount.
     */
    cm: Field;
    /**
     * Only the depositor's note. The fee note belongs to the relayer and is excluded so the
     * wallet balance does not include value it cannot spend.
     */
    producedNotes: [Note];
}

export function buildDeposit(a: DepositArgs): BuiltDeposit {
    const { P, J } = a;

    // One leaf: the note, its encrypted payload, the `inner` the request publishes, and its
    // commitment. The batch circuit builds the leaf as
    // Poseidon(TAG_CM, asset·2^64 + value, inner) from the request's own asset and amount, so
    // `cm` is computed the same way here and the note opens only as that (asset, value).
    const leaf = (
        asset: bigint,
        value: bigint,
        recipient: OutputRecipient,
        r: DepositArgs["output0"],
    ): { note: Note; aux: AuxOutput; inner: Field; cm: Field } => {
        const note: Note = { asset, value, pk: recipient.pk, rho: r.rho, rcm: r.rcm };
        const inner = buildInner(P, note);
        return {
            note,
            aux: auxOutputToWire(buildAuxForReal(J, P, note, recipient, r.aux).aux),
            inner,
            cm: commitWithInner(P, asset, value, inner),
        };
    };

    const out = leaf(a.asset, a.publicIn, a.recipient, a.output0);
    // The relayer's leaf, built like the depositor's. The batch circuit builds each leaf from
    // its own `(asset, value, inner)`, so the fee may be in another asset.
    //
    // A zero-value note names asset 0: the pool reverts `FeeAssetMustBeZero` otherwise, and
    // the circuit hashes the request's `feeAssetId` into the leaf, so the note's plaintext
    // must carry the same id to open it.
    const feeAsset = a.fee.value === 0n ? 0n : (a.fee.asset ?? a.asset);
    const fee = leaf(feeAsset, a.fee.value, a.fee.recipient, a.fee);

    const deposit: DepositRequest = {
        chainId: a.chainId,
        publicAssetId: a.asset,
        publicIn: a.publicIn,
        payer: a.payerAddress,
        recipient: a.recipientAddress,
        inner: fieldToBytes32(out.inner),
        feeAssetId: feeAsset,
        feeIn: a.fee.value,
        feeInner: fieldToBytes32(fee.inner),
    };

    return { deposit, aux: out.aux, feeAux: fee.aux, cm: out.cm, producedNotes: [out.note] };
}
