// Builds the result objects declared in `./result.ts`.
//
// Named for what it does rather than for what it is not. As `internal.ts`
// it collided with `src/internal.ts`, which is the opposite thing: a
// *published* subpath (`@lelantos-org/sdk/internal`) carrying deliberately
// unstable primitives. One word, two meanings, one directory apart.

import { type AssetId, branded, type CircuitAmount, type Hex32 } from "../core/brand.js";
import { type DepositStrategy, InternalError } from "../core/errors.js";
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

/**
 * Index of an output slot, `0 .. nOut - 1`.
 *
 * A plain `number` rather than a literal union: `nOut` is a property of the
 * circuit shape, so the valid range is not known at compile time.
 * `buildTransactionResult` bounds-checks against the commitments it was given.
 */
export type OutputSlot = number;

/** Shared subset of `BuiltBundle` / `BuiltDeposit`. */
export interface BuiltLike {
    /** One per output slot: `nOut` at spend, always 1 for a deposit. */
    cm: Field[];
    producedNotes: Note[];
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
    depositId?: bigint | undefined;
    /**
     * Slots of `built.cm` holding own commitments.
     *
     * Spend output slots are shuffled, so these are whatever indices the
     * shuffle landed the caller's own slots on rather than a fixed set. Only
     * the deposit path, whose slots are pinned by the contract ABI, has a
     * constant answer (`[0]`).
     */
    ownIndices?: OutputSlot[] | undefined;
    /** Transfer only: the shuffled slot holding the payee's note. */
    payeeIndex?: OutputSlot | undefined;
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
    const commitments: Hex32[] = args.built.cm.map(fieldToBytes32);
    const spent = args.spent ?? [];
    const ownIndices: OutputSlot[] = args.ownIndices ?? [];
    // Drop zero-value outputs: scanner skips them as self-pad, so waiters
    // on these commitments would hang.
    const valueAt = (i: OutputSlot): bigint => {
        const note = args.built.producedNotes[i];
        if (note === undefined) {
            throw new InternalError(
                `ownIndices names slot ${i}, which the bundle has no output for`,
            );
        }
        return BigInt(note.value);
    };
    const ownIndicesNonZero = ownIndices.filter((i) => valueAt(i) > 0n);
    const ownCommitments = ownIndicesNonZero.map((i) => commitments[i]!);
    const ownInflow = branded<CircuitAmount>(
        ownIndicesNonZero.reduce((acc, i) => acc + valueAt(i), 0n),
    );
    // Commitments any party will scan — drops zero-value pad
    // outputs. Receiver-side waiters should subset this against their own
    // address rather than waiting on the full `commitments` pair.
    const nonZeroCommitments: Hex32[] = commitments.filter((_, i) => valueAt(i) > 0n);

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
                ...(args.depositId !== undefined ? { depositId: args.depositId } : {}),
            };
        case "transfer": {
            // `executeTransfer` rejects a non-positive amount, so the payee's
            // slot always exists and always carries value — unlike change,
            // which legitimately lands on zero.
            if (args.payeeIndex === undefined) {
                throw new InternalError("a transfer receipt needs the payee's slot");
            }
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
                recipientCommitment: commitments[args.payeeIndex]!,
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
                ...(args.depositId !== undefined ? { depositId: args.depositId } : {}),
            };
    }
}
