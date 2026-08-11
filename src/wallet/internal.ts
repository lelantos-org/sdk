import type { DepositStrategy } from "../core/errors.js";
// Private helpers used by `Wallet`.

import type { Field } from "../crypto/index.js";
import type { Note } from "../notes/note.js";
import type { TransactionResult, TransferResult, WalletNote } from "./api.js";
import type { StoredNote } from "./note-store.js";

/** `notePayload()` recomputes on each call. */
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

/** Shared subset of `BuiltBundle` / `BuiltIntent`. */
export interface BuiltLike {
    cm: [Field, Field];
    producedNotes: [Note, Note];
}

/**
 * Per-tx file passes its kind discriminator; `makeTransactionResult`
 * builds the union variant matching that kind. See `api.ts` for the
 * branch shapes.
 */
export type TransactionKind = TransactionResult["kind"];

/** Narrow the receipt union down to the variant produced by `kind`. */
export type ResultForKind<K extends TransactionKind> = Extract<TransactionResult, { kind: K }>;

export interface MakeTransactionResultArgs {
    kind: TransactionKind;
    txHash: string;
    built: BuiltLike;
    spent?: string[];
    inputSum?: bigint;
    sent?: bigint;
    change?: bigint;
    intentId?: bigint;
    /**
     * Indices into `built.cm` for own commitments. Deposit/withdraw: `[0,1]`;
     * transfer: `[1]`; self-transfer: `[0,1]`.
     */
    ownIndices?: number[];
    /** Deposit only: which adapter path was taken. */
    strategy?: DepositStrategy;
}

export function makeTransactionResult<K extends TransactionKind>(
    args: MakeTransactionResultArgs & { kind: K },
): ResultForKind<K> {
    return buildTransactionResult(args) as ResultForKind<K>;
}

function buildTransactionResult(args: MakeTransactionResultArgs): TransactionResult {
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
    // Commitments any party will scan — drops zero-value pad
    // outputs. Receiver-side waiters should subset this against their own
    // address rather than waiting on the full `commitments` pair.
    const nonZeroCommitments: string[] = [];
    for (let i = 0; i < commitments.length; i++) {
        if (BigInt(args.built.producedNotes[i].value) > 0n) {
            nonZeroCommitments.push(commitments[i]);
        }
    }

    switch (args.kind) {
        case "deposit":
            return {
                kind: "deposit",
                strategy: args.strategy ?? "witness",
                txHash: args.txHash,
                commitments,
                nonZeroCommitments,
                ownCommitments,
                ownInflow,
                sent: args.sent ?? 0n,
                ...(args.intentId !== undefined ? { intentId: args.intentId } : {}),
            };
        case "transfer": {
            const r: TransferResult = {
                kind: "transfer",
                txHash: args.txHash,
                commitments,
                nonZeroCommitments,
                spent,
                inputSum: args.inputSum ?? 0n,
                sent: args.sent ?? 0n,
                change: args.change ?? 0n,
                ownCommitments,
                ownInflow,
            };
            return r;
        }
        case "withdraw":
            return {
                kind: "withdraw",
                txHash: args.txHash,
                commitments,
                nonZeroCommitments,
                spent,
                inputSum: args.inputSum ?? 0n,
                sent: args.sent ?? 0n,
                change: args.change ?? 0n,
                ownCommitments,
                ownInflow,
            };
        case "swap":
            return {
                kind: "swap",
                txHash: args.txHash,
                commitments,
                nonZeroCommitments,
                spent,
                inputSum: args.inputSum ?? 0n,
                sent: args.sent ?? 0n,
                change: args.change ?? 0n,
                ownCommitments,
                ownInflow,
                ...(args.intentId !== undefined ? { intentId: args.intentId } : {}),
            };
    }
}
