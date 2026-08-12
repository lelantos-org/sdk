// Private helpers used by `Wallet`.

import { type AssetId, branded, type CircuitAmount, type Hex32 } from "../core/brand.js";
import type { DepositStrategy } from "../core/errors.js";
import { fieldToBytes32 } from "../core/hex.js";
import type { Field } from "../crypto/index.js";
import type { Note } from "../notes/note.js";
import type { TransactionResult, TransferResult, WalletNote } from "./api.js";
import type { StoredNote } from "./note-store.js";

/** `notePayload()` recomputes on each call. */
export function toWalletNote(s: StoredNote): WalletNote {
    return {
        id: s.id,
        asset: branded<AssetId>(BigInt(s.asset)),
        value: branded<CircuitAmount>(BigInt(s.value)),
        spent: s.spent,
        ...(s.firstSeenBlock !== undefined ? { firstSeenBlock: s.firstSeenBlock } : {}),
        discoveredAt: s.discoveredAt,
        cm: branded<Hex32>(s.cm),
        notePayload: () => ({
            asset: branded<AssetId>(BigInt(s.asset)),
            value: branded<CircuitAmount>(BigInt(s.value)),
            rho: BigInt(s.rho),
            rcm: BigInt(s.rcm),
            rcvDep: BigInt(s.rcvDep),
        }),
    };
}

/** The transact circuit has exactly two output slots. */
export type OutputSlot = 0 | 1;

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
    txHash: Hex32;
    built: BuiltLike;
    spent?: string[] | undefined;
    inputSum?: CircuitAmount | undefined;
    sent?: CircuitAmount | undefined;
    change?: CircuitAmount | undefined;
    intentId?: bigint | undefined;
    /**
     * Slots of `built.cm` holding own commitments. Deposit/withdraw: `[0, 1]`;
     * transfer: `[1]`; self-transfer: `[0, 1]`.
     */
    ownIndices?: OutputSlot[] | undefined;
    /** Deposit only: which adapter path was taken. */
    strategy?: DepositStrategy | undefined;
}

export function makeTransactionResult<K extends TransactionKind>(
    args: MakeTransactionResultArgs & { kind: K },
): ResultForKind<K> {
    return buildTransactionResult(args) as ResultForKind<K>;
}

const ZERO = branded<CircuitAmount>(0n);

function buildTransactionResult(args: MakeTransactionResultArgs): TransactionResult {
    const commitments: [Hex32, Hex32] = [
        fieldToBytes32(args.built.cm[0]),
        fieldToBytes32(args.built.cm[1]),
    ];
    const spent = args.spent ?? [];
    const ownIndices: OutputSlot[] = args.ownIndices ?? [];
    // Drop zero-value outputs: scanner skips them as self-pad, so waiters
    // on these commitments would hang.
    const ownIndicesNonZero = ownIndices.filter(
        (i) => BigInt(args.built.producedNotes[i].value) > 0n,
    );
    const ownCommitments = ownIndicesNonZero.map((i) => commitments[i]);
    const ownInflow = branded<CircuitAmount>(
        ownIndicesNonZero.reduce((acc, i) => acc + BigInt(args.built.producedNotes[i].value), 0n),
    );
    // Commitments any party will scan — drops zero-value pad
    // outputs. Receiver-side waiters should subset this against their own
    // address rather than waiting on the full `commitments` pair.
    const nonZeroCommitments: Hex32[] = ([0, 1] as const)
        .filter((i) => BigInt(args.built.producedNotes[i].value) > 0n)
        .map((i) => commitments[i]);

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
                sent: args.sent ?? ZERO,
                ...(args.intentId !== undefined ? { intentId: args.intentId } : {}),
            };
        case "transfer": {
            const r: TransferResult = {
                kind: "transfer",
                txHash: args.txHash,
                commitments,
                nonZeroCommitments,
                spent,
                inputSum: args.inputSum ?? ZERO,
                sent: args.sent ?? ZERO,
                change: args.change ?? ZERO,
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
                inputSum: args.inputSum ?? ZERO,
                sent: args.sent ?? ZERO,
                change: args.change ?? ZERO,
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
                inputSum: args.inputSum ?? ZERO,
                sent: args.sent ?? ZERO,
                change: args.change ?? ZERO,
                ownCommitments,
                ownInflow,
                ...(args.intentId !== undefined ? { intentId: args.intentId } : {}),
            };
    }
}
