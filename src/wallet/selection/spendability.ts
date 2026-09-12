// Which notes a spend may touch, and what each rule held back.
//
// One statement of "spendable", shared by every selector and by `spendableMax`:
// two independent copies would let the prediction drift from the answer, which
// is the failure `spendableMax` exists to prevent.

import type { AssetId } from "../../core/brand.js";
import { type StoredNote, withinReservation } from "../note-store.js";
import { DEFAULT_COOLDOWN_BLOCKS, type SelectOpts, type WithheldValue } from "./types.js";

/**
 * Per-rule tally of notes excluded from a selection. Reported in the
 * `SelectionError` message, which otherwise cannot distinguish an empty wallet
 * from an all-dust, wrong-asset or fully-cooled-down one.
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
    },
): { candidates: StoredNote[]; rejected: RejectionCounts; withheld: WithheldValue } {
    const rejected: RejectionCounts = {
        spent: 0,
        reserved: 0,
        otherAsset: 0,
        dust: 0,
        cooldown: 0,
        notNamed: 0,
    };
    // Value, not counts. A caller explaining why a max sits below the balance
    // needs the amount each rule held back, and the tally above cannot say.
    const withheld: WithheldValue = { reserved: 0n, dust: 0n, cooldown: 0n, slots: 0n };
    const candidates: StoredNote[] = [];

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
        } else if (withinReservation(n.pendingSpendAt, rules.now)) {
            // A spend of this note is outstanding: it may already be spent,
            // and offering it again earns a duplicate rejection, not a tx.
            rejected.reserved++;
            withheld.reserved += value;
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
    return { candidates, rejected, withheld };
}

/**
 * The spendability rules `opts` asks for, with every default resolved.
 *
 * Shared by `selectNotes` and `spendableMax` because the second exists to
 * predict the first: two independent statements of what "spendable" defaults
 * to would let the prediction drift from the answer, which is the whole failure
 * `spendableMax` was added to prevent.
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

/** `"8 spent, 3 below dust threshold"` — omits rules that rejected nothing. */
export function describeRejections(r: RejectionCounts): string {
    const reasons: ReadonlyArray<readonly [count: number, label: string]> = [
        [r.spent, "spent"],
        [r.reserved, "awaiting an earlier spend"],
        [r.otherAsset, "other asset"],
        [r.dust, "below dust threshold"],
        [r.cooldown, "in spend cooldown"],
        [r.notNamed, "not named by `only`"],
    ];
    const held = reasons
        .filter(([count]) => count > 0)
        .map(([count, label]) => `${count} ${label}`);
    return held.length > 0 ? held.join(", ") : "none held";
}
