// Funds errors: balance, held notes, cover, fee asset.
//
// Four distinct answers to "why can't this spend be funded?", each with its own
// remedy:
//
//   * `INSUFFICIENT_BALANCE`: the unspent notes of the asset do not add up to
//     the amount. Top up or send less.
//   * `NOTES_HELD`: they would, but some are held back (reserved by an earlier
//     spend, in their spend cooldown, or below the dust threshold). Usually a
//     wait; `retryable` says whether waiting alone can fix it.
//   * `INSUFFICIENT_COVER`: the spendable notes add up, but no combination fits
//     the circuit's input slots. Consolidate.
//   * `FEE_ASSET_NOT_QUOTED`: the relayer will not take the asset named to pay
//     its fee. Pick one of `accepted`.
//
// Amounts, asset ids and note ids are typed fields, never part of the message,
// which reaches application logs verbatim.

import type { AssetId, CircuitAmount } from "../core/brand.js";
import { WalletError, type WalletErrorOptions } from "./base.js";

/**
 * Fields required by the consolidation recovery flow.
 *
 * `InsufficientCoverError` carries this rather than `StoredNote`: it is thrown
 * on the ordinary cover-failure path and so reaches application error
 * reporting, where `rho`, `rcm` and `rcvDep` are note secrets and `cm`
 * identifies a pool leaf.
 */
export interface ConsolidateHint {
    id: string;
    value: string;
}

/**
 * The unspent notes of `asset`, all of them counted, do not reach `required`.
 *
 * Distinct from {@link NotesHeldError}: nothing is being held back, so no
 * wait helps. `available` is every unspent note of the asset the spend was
 * allowed to consider.
 */
export class InsufficientBalanceError extends WalletError<"INSUFFICIENT_BALANCE"> {
    readonly asset: AssetId;
    /** Unspent value of `asset`, held-back notes included, in circuit units. */
    readonly available: CircuitAmount;
    /** What the spend needed, same-asset fee included, in circuit units. */
    readonly required: CircuitAmount;

    constructor(
        args: { asset: AssetId; available: CircuitAmount; required: CircuitAmount },
        opts?: WalletErrorOptions,
    ) {
        super(
            "INSUFFICIENT_BALANCE",
            "insufficient balance: the unspent notes of this asset do not cover the amount " +
                "(see `available` and `required`); sync, top up, or send less",
            opts,
        );
        this.name = "InsufficientBalanceError";
        this.asset = args.asset;
        this.available = args.available;
        this.required = args.required;
    }
}

/** Value and number of notes one spendability rule held back. */
export interface HeldBucket {
    value: CircuitAmount;
    count: number;
}

/** What each spendability rule held back from a selection. */
export interface HeldNotes {
    /**
     * Notes reserved by another spend: one this wallet is running right now,
     * or an earlier one whose outcome is not yet known.
     */
    reserved: HeldBucket;
    /** Notes younger than the spend cooldown. Released as blocks arrive. */
    cooldown: HeldBucket;
    /** Notes below the dust threshold. Never released by waiting. */
    dust: HeldBucket;
}

/**
 * The balance covers `required`, but not without notes that are held back.
 *
 * `retryable` is true when the reserved and cooling-down notes alone make up
 * the shortfall, so the same call will succeed once they are released (an
 * in-flight spend settles, a reservation expires, a block arrives). When only
 * dust would close the gap it is false: lower `dustThreshold` or send less.
 */
export class NotesHeldError extends WalletError<"NOTES_HELD"> {
    readonly asset: AssetId;
    readonly required: CircuitAmount;
    /** Value the selector was free to use. */
    readonly spendable: CircuitAmount;
    readonly held: HeldNotes;
    /**
     * When the last known reservation lapses, if any note is reserved by an
     * earlier spend with an unknown outcome. Absent when the only reservations
     * are spends still running in this wallet.
     */
    readonly reservedUntil?: Date | undefined;

    constructor(
        args: {
            asset: AssetId;
            required: CircuitAmount;
            spendable: CircuitAmount;
            held: HeldNotes;
            reservedUntil?: Date | undefined;
        },
        opts?: WalletErrorOptions,
    ) {
        const { held } = args;
        const parts: string[] = [];
        if (held.reserved.count > 0) parts.push(`${held.reserved.count} awaiting an earlier spend`);
        if (held.cooldown.count > 0) parts.push(`${held.cooldown.count} in spend cooldown`);
        if (held.dust.count > 0) parts.push(`${held.dust.count} below dust threshold`);
        const retryable =
            args.spendable + held.reserved.value + held.cooldown.value >= args.required;
        super(
            "NOTES_HELD",
            `not enough spendable notes right now (${parts.join(", ") || "none held"}); ` +
                (retryable
                    ? "retry once they are released"
                    : "the rest is dust, so waiting will not help: lower the dust threshold or send less"),
            { ...opts, retryable },
        );
        this.name = "NotesHeldError";
        this.asset = args.asset;
        this.required = args.required;
        this.spendable = args.spendable;
        this.held = held;
        if (args.reservedUntil !== undefined) this.reservedUntil = args.reservedUntil;
    }
}

/** Why no cover fit the circuit's input slots. */
export type InsufficientCoverReason =
    /** More notes would be needed than the circuit has input slots. */
    | "arity"
    /** The spend took every slot, leaving none for a note paying a cross-asset fee. */
    | "fee-slot";

/**
 * The balance covers `target`, but no combination within the circuit's input
 * arity does. Merging the notes in `consolidate` into one fixes it.
 *
 * `consolidationAttempted` distinguishes the two ways this is reached:
 *
 *   * `false`: the caller did not ask for consolidation. Self-spend
 *     `consolidate`, re-sync, and retry, or pass `{ autoConsolidate: true }`.
 *   * `true`: consolidation ran and the cover still did not appear.
 *     Repeating the same call will not help.
 */
export class InsufficientCoverError extends WalletError<"INSUFFICIENT_COVER"> {
    readonly target: CircuitAmount;
    readonly asset: AssetId;
    readonly consolidate: ConsolidateHint[];
    readonly consolidateSum: CircuitAmount;
    /** Whether consolidation ran before this was thrown. */
    readonly consolidationAttempted: boolean;
    readonly reason: InsufficientCoverReason;

    constructor(
        args: {
            target: CircuitAmount;
            asset: AssetId;
            consolidate: ConsolidateHint[];
            consolidateSum: CircuitAmount;
            consolidationAttempted?: boolean | undefined;
            reason?: InsufficientCoverReason | undefined;
        },
        opts?: WalletErrorOptions,
    ) {
        // Counted from the hint list rather than hardcoded, so the message
        // tracks the deployed circuit's input arity.
        const n = args.consolidate.length;
        const notes = `${n} smallest note${n === 1 ? "" : "s"}`;
        const attempted = args.consolidationAttempted ?? false;
        const reason = args.reason ?? "arity";
        const detail =
            reason === "fee-slot"
                ? "; the spend uses every input slot, leaving none for the fee asset: consolidate " +
                  "the asset being moved, or pay the fee in it"
                : attempted
                  ? ` after consolidating; the ${notes} (see \`consolidate\`) still do not ` +
                    "combine to reach the target"
                  : `; consolidate the ${notes} (see \`consolidate\`), then re-run — or pass ` +
                    "{ autoConsolidate: true }";
        super("INSUFFICIENT_COVER", `no cover within the circuit's input arity${detail}`, opts);
        this.name = "InsufficientCoverError";
        this.target = args.target;
        this.asset = args.asset;
        this.consolidate = args.consolidate;
        this.consolidateSum = args.consolidateSum;
        this.consolidationAttempted = attempted;
        this.reason = reason;
    }
}

/** What a relayer fee quote was requested for. */
export type FeeQuoteKind = "transfer" | "withdraw" | "withdrawNative" | "swap" | "deposit";

/**
 * The relayer charges a fee but quoted nothing for the asset named to pay it,
 * so it would refuse (or, for a deposit, never flush) the operation.
 *
 * Checked before proving or signing. `accepted` lists the assets the relayer
 * did quote; paying in one of them fixes it.
 */
export class FeeAssetNotQuotedError extends WalletError<"FEE_ASSET_NOT_QUOTED"> {
    readonly asset: AssetId;
    /** The operation priced; absent when raised by a low-level builder that was not told. */
    readonly kind?: FeeQuoteKind | undefined;
    /** Assets the relayer quoted a payable amount for, in its order. */
    readonly accepted: AssetId[];

    constructor(
        args: { asset: AssetId; kind?: FeeQuoteKind | undefined; accepted: AssetId[] },
        opts?: WalletErrorOptions,
    ) {
        super(
            "FEE_ASSET_NOT_QUOTED",
            "the relayer charges a fee but quoted no amount for asset chosen to pay it; " +
                (args.accepted.length > 0
                    ? "pay the fee in one of `accepted`"
                    : "it quoted no payable asset at all, so this operation cannot be relayed"),
            opts,
        );
        this.name = "FeeAssetNotQuotedError";
        this.asset = args.asset;
        if (args.kind !== undefined) this.kind = args.kind;
        this.accepted = args.accepted;
    }
}
