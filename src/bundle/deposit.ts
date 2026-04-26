// Deposit intent builder. Does NOT prove — deposits go through
// `MASP.submitIntent` (Permit2 witness). Returns a `BuiltIntent` for the
// wallet to sign + POST to `/v1/intent`.

import { BN254_FR } from "../core/field.js";
import { randomFr } from "../core/random.js";
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
    /** Per-output randomness for the real output (slot 0). */
    output0: { rho: Field; rcm: Field; rcv: Field; rcvDep: Field; aux: OutputRandomness };
    /**
     * Pad output (slot 1) — gets a real FMD clue + ECDH so the recipient's
     * indexer can match it the same way as the real note.
     */
    output1Pad: { rho: Field; rcm: Field; rcv: Field; rcvDep: Field };
}

/** @internal */
export interface BuiltIntent {
    /**
     * Plaintext DepositIntent — the wallet hashes this with `aux` to derive
     * the Permit2 witness `piHash`, then signs the Permit2 typed-data.
     */
    intent: DepositIntent;
    /** Per-output FMD clue + ECDH + ciphertext. Bound into `piHash`. */
    aux: [AuxOutput, AuxOutput];
    cm: [Field, Field];
    producedNotes: [Note, Note];
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
    const padOut: Note = {
        asset: a.asset,
        value: 0n,
        pk: a.recipient.pk,
        rho: a.output1Pad.rho,
        rcm: a.output1Pad.rcm,
        rcv: a.output1Pad.rcv,
        rcvDep: a.output1Pad.rcvDep,
    };

    const aux0 = buildAuxForReal(J, P, realOut, a.recipient, a.output0.aux);
    const aux1 = buildAuxForReal(J, P, padOut, a.recipient, {
        esk: randomFr(),
        fmdR: randomFr(),
    });

    const cm0 = buildNoteCommitment(P, realOut);
    const cm1 = buildNoteCommitment(P, padOut);

    // Deposit-anchor Pedersen value commitments. cv_dep_j = value_j · V^asset
    // + rcv_dep_j · H. Baked into the leaf via Poseidon(TAG_LEAF, cm, cv_dep)
    // so the spender cannot open the cm under a different (asset, value) at
    // spend time.
    const assetGen = J.hashToAssetGen(a.asset);
    const cvDep0 = J.valueCommit(realOut.value, assetGen, realOut.rcvDep);
    const cvDep1 = J.valueCommit(padOut.value, assetGen, padOut.rcvDep);
    const rcvTotal = (realOut.rcvDep + padOut.rcvDep) % BN254_FR;

    const intent: DepositIntent = {
        chainId: a.chainId,
        publicAssetId: a.asset,
        publicIn: a.publicIn,
        payer: a.payerAddress,
        recipient: a.recipientAddress,
        outCm: [fieldToBytes32(cm0), fieldToBytes32(cm1)],
        cvDep0: [cvDep0[0], cvDep0[1]],
        cvDep1: [cvDep1[0], cvDep1[1]],
        rcvTotal,
        // Pad-leaf blinder alone, so tree_update_batch can prove cv_dep1 is a
        // value-0 commitment and thereby pin cv_dep0 to exactly publicIn.
        rcvDepPad: padOut.rcvDep,
    };

    return {
        intent,
        aux: [auxOutputToWire(aux0.aux), auxOutputToWire(aux1.aux)],
        cm: [cm0, cm1],
        producedNotes: [realOut, padOut],
    };
}
