// Which notes a spend may touch, and what each rule held back.
//
// The single definition of "spendable", shared by every selector and by
// `spendableMax` so its prediction cannot drift from the selector's answer.

import { type AssetId, branded, type CircuitAmount } from "../../core/brand.js";
import { InsufficientBalanceError, NotesHeldError } from "../../errors/funds.js";
import { SPEND_RESERVATION_MS } from "../constants.js";
import { type StoredNote, withinReservation } from "../notes/note-store.js";
import { DEFAULT_COOLDOWN_BLOCKS, type SelectOpts, type WithheldValue } from "./types.js";

/**
 * Per-rule tally of notes excluded from a selection. Carried by
 * `NotesHeldError`, which otherwise could not distinguish an all-dust
 * wallet from a fully-reserved or fully-cooled-down one.
 */
interface RejectionCounts {
    spent: number;
    reserved: number;
    otherAsset: number;
    dust: number;
    cooldown: number;
    /** Excluded by `SelectOpts.only`. Zero unless a caller passed one. */
    notNamed: number;
}

/** Notes that survive every spendability rule, plus a tally of what did not. */
export function partitionSpendable(
    all: readonly StoredNote[],
    asset: AssetId,
    rules: {
        dust: bigint;
        cooldown: number;
        tip: number | undefined;
        now: number;
        only?: ReadonlySet<string> | undefined;
        /**
         * Notes an in-flight spend of this wallet holds. Counted as reserved.
         * `ensureCover` removes them before calling a selector, so a selector
         * never sees them; the funding error it raises is rebuilt with them.
         */
        leased?: { has(id: string): boolean } | undefined;
    },
): {
    candidates: StoredNote[];
    rejected: RejectionCounts;
    withheld: WithheldValue;
    /** Latest expiry (ms since epoch) of a persisted reservation, if any note carries one. */
    reservedUntilMs: number | undefined;
} {
    const rejected: RejectionCounts = {
        spent: 0,
        reserved: 0,
        otherAsset: 0,
        dust: 0,
        cooldown: 0,
        notNamed: 0,
    };
    // Value held back per rule, used to explain why a max is below the balance.
    const withheld: WithheldValue = { reserved: 0n, dust: 0n, cooldown: 0n, slots: 0n };
    const candidates: StoredNote[] = [];
    let reservedUntilMs: number | undefined;

    for (const n of all) {
        const value = BigInt(n.value);
        if (n.spent) {
            rejected.spent++;
        } else if (rules.only !== undefined && !rules.only.has(n.id)) {
            rejected.notNamed++;
        } else if (BigInt(n.asset) !== asset) {
            // Ordered before the value rules so a note of another asset is not
            // counted into this asset's withheld totals.
            rejected.otherAsset++;
        } else if (rules.leased?.has(n.id)) {
            // A spend running in this wallet holds it.
            rejected.reserved++;
            withheld.reserved += value;
        } else if (withinReservation(n.pendingSpendAt, rules.now)) {
            // A spend of this note is outstanding and may already have landed;
            // reselecting it would cause a duplicate rejection.
            rejected.reserved++;
            withheld.reserved += value;
            const until = Date.parse(n.pendingSpendAt!) + SPEND_RESERVATION_MS;
            reservedUntilMs =
                reservedUntilMs === undefined ? until : Math.max(reservedUntilMs, until);
        } else if (value < rules.dust) {
            rejected.dust++;
            withheld.dust += value;
        } else if (inCooldown(n, rules)) {
            rejected.cooldown++;
            withheld.cooldown += value;
        } else {
            candidates.push(n);
        }
    }
    return { candidates, rejected, withheld, reservedUntilMs };
}

/**
 * The error for a selection whose spendable notes do not reach `required`.
 *
 * `INSUFFICIENT_BALANCE` when even the held-back notes would not close the gap,
 * so no wait helps; `NOTES_HELD` when they would, with what each rule held.
 * Notes excluded by `only` or of another asset count toward neither.
 */
export function fundingError(
    all: readonly StoredNote[],
    asset: AssetId,
    required: bigint,
    rules: Parameters<typeof partitionSpendable>[2],
): InsufficientBalanceError | NotesHeldError {
    const { candidates, rejected, withheld, reservedUntilMs } = partitionSpendable(
        all,
        asset,
        rules,
    );
    const spendable = sum(candidates.map((n) => BigInt(n.value)));
    const heldValue = withheld.reserved + withheld.cooldown + withheld.dust;
    if (spendable + heldValue < required) {
        return new InsufficientBalanceError({
            asset,
            available: branded<CircuitAmount>(spendable + heldValue),
            required: branded<CircuitAmount>(required),
        });
    }
    const bucket = (value: bigint, count: number) => ({
        value: branded<CircuitAmount>(value),
        count,
    });
    return new NotesHeldError({
        asset,
        required: branded<CircuitAmount>(required),
        spendable: branded<CircuitAmount>(spendable),
        held: {
            reserved: bucket(withheld.reserved, rejected.reserved),
            cooldown: bucket(withheld.cooldown, rejected.cooldown),
            dust: bucket(withheld.dust, rejected.dust),
        },
        ...(reservedUntilMs !== undefined ? { reservedUntil: new Date(reservedUntilMs) } : {}),
    });
}

/**
 * The spendability rules `opts` asks for, with every default resolved.
 *
 * Shared by `selectNotes` and `spendableMax` so the latter's prediction uses
 * the same defaults as the former.
 */
export function spendRules(opts: SelectOpts) {
    return {
        dust: opts.dustThreshold ?? 0n,
        cooldown: opts.cooldownBlocks ?? DEFAULT_COOLDOWN_BLOCKS,
        tip: opts.tipBlock,
        now: Date.now(),
        ...(opts.only ? { only: new Set(opts.only) } : {}),
    };
}

/** Total of a bigint list. */
export function sum(vs: readonly bigint[]): bigint {
    return vs.reduce((a, v) => a + v, 0n);
}

/**
 * Whether a note is younger than `cooldown` blocks.
 *
 * Requires both a tip and a per-note `firstSeenBlock`; without either, every
 * note is treated as spendable.
 */
function inCooldown(n: StoredNote, rules: { cooldown: number; tip: number | undefined }): boolean {
    if (rules.cooldown <= 0 || rules.tip === undefined) return false;
    if (n.firstSeenBlock === undefined) return false;
    return rules.tip - n.firstSeenBlock < rules.cooldown;
}
