// Private helpers used by `Wallet`.

import type { Field } from "../crypto/index.js";
import type { Note } from "../notes.js";
import type { AuxOutput } from "../permit2.js";
import type { TransactAux } from "../relayer.js";
import type { TransactionResult, WalletNote } from "./api.js";
import type { StoredNote } from "./note-store.js";
import { randomFr, randomJubjubScalar } from "./randomness.js";

/// Slot-0 deposit randomness: rho/rcm/rcv/rcvDep + FMD aux.
export interface OutputRandomness {
    rho: Field;
    rcm: Field;
    rcv: Field;
    rcvDep: Field;
    aux: { esk: Field; fmdR: Field };
}

export function freshOutput(): OutputRandomness {
    return {
        rho: randomFr(),
        rcm: randomFr(),
        rcv: randomJubjubScalar(),
        rcvDep: randomJubjubScalar(),
        aux: { esk: randomJubjubScalar(), fmdR: randomJubjubScalar() },
    };
}

export function freshNoteRandomness(): { rho: Field; rcm: Field; rcv: Field; rcvDep: Field } {
    return {
        rho: randomFr(),
        rcm: randomFr(),
        rcv: randomJubjubScalar(),
        rcvDep: randomJubjubScalar(),
    };
}

/// Bridge flat-scalar `AuxOutput` (piHash shape) → point-as-tuple
/// `TransactAux` (relayer wire shape) for swap.
export function auxOutputToTransactAux(a: AuxOutput): TransactAux {
    return {
        clueR: [a.clueRx, a.clueRy],
        ephPub: [a.ephPubX, a.ephPubY],
        ciphertext: a.ciphertext,
    };
}

/// `notePayload()` recomputes on each call.
export function toWalletNote(s: StoredNote): WalletNote {
    return {
        id: s.id,
        asset: BigInt(s.asset),
        value: BigInt(s.value),
        spent: s.spent,
        firstSeenBlock: s.firstSeenBlock,
        discoveredAt: s.discoveredAt,
        cm: s.cm,
        notePayload: () => ({
            asset: BigInt(s.asset),
            value: BigInt(s.value),
            rho: BigInt(s.rho),
            rcm: BigInt(s.rcm),
            rcvDep: BigInt(s.rcvDep),
        }),
    };
}

/// Shared subset of `BuiltBundle` / `BuiltIntent`.
export interface BuiltLike {
    cm: [Field, Field];
    producedNotes: [Note, Note];
}

export interface MakeTransactionResultArgs {
    txHash: string;
    built: BuiltLike;
    spent?: string[];
    inputSum?: bigint;
    sent?: bigint;
    change?: bigint;
    /// Indices into `built.cm` for own commitments. Deposit/withdraw: `[0,1]`;
    /// transfer: `[1]`; self-transfer: `[0,1]`.
    ownIndices?: number[];
}

export function makeTransactionResult(args: MakeTransactionResultArgs): TransactionResult {
    const commitments: [string, string] = [
        `0x${args.built.cm[0].toString(16).padStart(64, "0")}`,
        `0x${args.built.cm[1].toString(16).padStart(64, "0")}`,
    ];
    const spent = args.spent ?? [];
    const ownIndices = args.ownIndices ?? [];
    // Drop zero-value outputs: scanner skips them as self-pad, so waiters
    // on these commitments would hang.
    const ownIndicesNonZero = ownIndices.filter(
        (i) => BigInt(args.built.producedNotes[i].value) > 0n,
    );
    const ownCommitments = ownIndicesNonZero.map((i) => commitments[i]);
    const ownInflow = ownIndicesNonZero.reduce(
        (acc, i) => acc + BigInt(args.built.producedNotes[i].value),
        0n,
    );
    return {
        txHash: args.txHash,
        commitments,
        spent,
        inputSum: args.inputSum ?? 0n,
        sent: args.sent ?? 0n,
        change: args.change ?? 0n,
        ownCommitments,
        ownInflow,
        // Back-compat aliases.
        cm: commitments,
        spentNoteIds: spent,
    };
}
