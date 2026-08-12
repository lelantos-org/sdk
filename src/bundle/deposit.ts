// Deposit intent builder. Does NOT prove — deposits go through
// `MASP.submitIntent` (Permit2 witness). Returns a `BuiltIntent` for the
// wallet to sign + POST to `/v1/intent`.

import { buildNoteCommitment, type Field, type Jubjub, type Poseidon } from "../crypto/index.js";
import type { Note } from "../notes/note.js";
import { auxOutputToWire } from "../protocol/aux-wire.js";
import type { AuxOutput, DepositIntent } from "../protocol/deposit-intent.js";
import {
    buildAuxForReal,
    fieldToBytes32,
    type OutputRandomness,
    type OutputRecipient,
} from "./common.js";

/** @internal */
export interface DepositArgs {
    P: Poseidon;
    J: Jubjub;
    chainId: bigint;
    asset: bigint;
    /** 0x ETH; payer's account (Permit2 transfer source). */
    payerAddress: string;
    /** 0x ETH; on-chain recipient (binds DepositIntent.recipient). */
    recipientAddress: string;
    publicIn: bigint;
    /**
     * Bech32m-decoded shielded address of the receiving wallet. Provides
     * the note-binding `pk` via the address payload.
     */
    recipient: OutputRecipient;
    /** Randomness for the single output. */
    output0: { rho: Field; rcm: Field; rcv: Field; rcvDep: Field; aux: OutputRandomness };
}

/** @internal */
export interface BuiltIntent {
    /**
     * Plaintext DepositIntent — the wallet hashes this with `aux` to derive
     * the Permit2 witness `piHash`, then signs the Permit2 typed-data.
     */
    intent: DepositIntent;
    /** FMD clue + ECDH + ciphertext for the output. Bound into `piHash`. */
    aux: AuxOutput;
    cm: Field;
    producedNotes: [Note];
}

export function buildDeposit(a: DepositArgs): BuiltIntent {
    const { P, J } = a;

    const realOut: Note = {
        asset: a.asset,
        value: a.publicIn,
        pk: a.recipient.pk,
        rho: a.output0.rho,
        rcm: a.output0.rcm,
        rcv: a.output0.rcv,
        rcvDep: a.output0.rcvDep,
    };

    const aux0 = buildAuxForReal(J, P, realOut, a.recipient, a.output0.aux);
    const cm0 = buildNoteCommitment(P, realOut);

    // Deposit-anchor Pedersen value commitment. cv_dep = value · V^asset
    // + rcv_dep · H. Baked into the leaf via Poseidon(TAG_LEAF, cm, cv_dep)
    // so the spender cannot open the cm under a different (asset, value) at
    // spend time.
    const assetGen = J.hashToAssetGen(a.asset);
    const cvDep = J.valueCommit(realOut.value, assetGen, realOut.rcvDep);

    const intent: DepositIntent = {
        chainId: a.chainId,
        publicAssetId: a.asset,
        publicIn: a.publicIn,
        payer: a.payerAddress,
        recipient: a.recipientAddress,
        outCm: fieldToBytes32(cm0),
        cvDep: [cvDep[0], cvDep[1]],
        rcv: realOut.rcvDep,
    };

    return {
        intent,
        aux: auxOutputToWire(aux0.aux),
        cm: cm0,
        producedNotes: [realOut],
    };
}
