// Deposit request builder. Does NOT prove — deposits go through
// `MASP.deposit` (Permit2 witness). Returns a `BuiltDeposit` for the
// wallet to sign + POST to `/v1/deposit`.

import { buildNoteCommitment, type Field, type Jubjub, type Poseidon } from "../crypto/index.js";
import type { Note } from "../notes/note.js";
import { auxOutputToWire } from "../protocol/aux-wire.js";
import type { AuxOutput, DepositRequest } from "../protocol/deposit-request.js";
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
     * The relayer's fee note: who it pays, how much, and its randomness.
     *
     * A deposit mints two leaves. `value` may be zero on a chain that
     * subsidises deposits — the leaf is still minted, so there is one shape
     * rather than two.
     */
    fee: {
        recipient: OutputRecipient;
        value: bigint;
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
     * Only the depositor's note. The fee note belongs to the relayer, so it is
     * absent: counting it would inflate the wallet's balance
     * with value it cannot spend.
     */
    producedNotes: [Note];
}

export function buildDeposit(a: DepositArgs): BuiltDeposit {
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

    // The relayer's leaf, built exactly like the depositor's — same asset, its
    // own value and blinders, addressed to the relayer's shielded address. The
    // batch circuit binds each leaf's `cvDep` to its own value independently,
    // which is what lets one deposit carry both.
    const feeOut: Note = {
        asset: a.asset,
        value: a.fee.value,
        pk: a.fee.recipient.pk,
        rho: a.fee.rho,
        rcm: a.fee.rcm,
        rcv: a.fee.rcv,
        rcvDep: a.fee.rcvDep,
    };
    const feeAux0 = buildAuxForReal(J, P, feeOut, a.fee.recipient, a.fee.aux);
    const feeCm = buildNoteCommitment(P, feeOut);
    const feeCvDep = J.valueCommit(feeOut.value, assetGen, feeOut.rcvDep);

    const deposit: DepositRequest = {
        chainId: a.chainId,
        publicAssetId: a.asset,
        publicIn: a.publicIn,
        payer: a.payerAddress,
        recipient: a.recipientAddress,
        outCm: fieldToBytes32(cm0),
        cvDep: [cvDep[0], cvDep[1]],
        rcv: realOut.rcvDep,
        feeIn: a.fee.value,
        feeCm: fieldToBytes32(feeCm),
        feeCvDep: [feeCvDep[0], feeCvDep[1]],
        feeRcv: feeOut.rcvDep,
    };

    return {
        deposit,
        aux: auxOutputToWire(aux0.aux),
        feeAux: auxOutputToWire(feeAux0.aux),
        cm: cm0,
        producedNotes: [realOut],
    };
}
