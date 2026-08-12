// Coin selector: SFRT — Smallest-First with Random Tiebreak.

import { type AssetId, branded, type CircuitAmount } from "../core/brand.js";
import { SelectionError } from "../core/errors.js";
import { randomFloat01 } from "../core/random.js";
import type { StoredNote } from "./note-store.js";

export interface SelectOpts {
    /** Cover threshold becomes `target + fee`. Default 0. */
    fee?: bigint | undefined;
    /** Notes with value < dustThreshold are excluded. Recommended: `2 * marginalFee`. */
    dustThreshold?: bigint | undefined;
    /**
     * Minimum age (blocks) before spendable. Requires `tipBlock` and
     * per-note `firstSeenBlock`; otherwise no-op.
     */
    cooldownBlocks?: number | undefined;
    tipBlock?: number | undefined;
    /** Tiebreak shuffle width: notes within `(1 ± bucketPct) * pivot`. Default 0.05. */
    bucketPct?: number | undefined;
    /** Injectable rng for tests. Returns float in [0, 1). */
    rng?: (() => number) | undefined;
}

export interface DirectSelection {
    plan: "direct";
    notes: StoredNote[];
    sum: CircuitAmount;
}

export interface ConsolidateFirst {
    plan: "consolidate-first";
    /** Two smallest spendable notes — caller self-spends them, retries after sync. */
    consolidate: StoredNote[];
    consolidateSum: CircuitAmount;
    /** `target + fee`. */
    targetWithFee: CircuitAmount;
}

export type SelectionResult = DirectSelection | ConsolidateFirst;

/**
 * Pick up to 2 unspent notes for `asset` summing to ≥ `target + fee` via SFRT.
 *
 * Rationale: largest-first leaves a value-ordering fingerprint (Tramèr USENIX'24);
 * randomized tiebreak restores indistinguishability (Chen & Bonneau FC'25);
 * smallest-pair drains dust so wallet note count shrinks over time.
 *
 * @internal
 */
export function selectNotes(
    all: readonly StoredNote[],
    asset: AssetId,
    target: CircuitAmount,
    opts: SelectOpts = {},
): SelectionResult {
    const fee = opts.fee ?? 0n;
    const dust = opts.dustThreshold ?? 0n;
    const cooldown = opts.cooldownBlocks ?? 0;
    const tip = opts.tipBlock;
    const bucketPct = opts.bucketPct ?? 0.05;
    const rng = opts.rng ?? randomFloat01;
    const threshold = target + fee;

    const candidates = all.filter((n) => {
        if (n.spent) return false;
        if (BigInt(n.asset) !== asset) return false;
        const v = BigInt(n.value);
        if (v < dust) return false;
        if (cooldown > 0 && tip !== undefined && n.firstSeenBlock !== undefined) {
            if (tip - n.firstSeenBlock < cooldown) return false;
        }
        return true;
    });

    if (candidates.length === 0) {
        throw new SelectionError(
            `no spendable notes for asset ${asset} (after dust/cooldown filter)`,
            { asset },
        );
    }

    const asc = [...candidates].sort((a, b) => cmp(BigInt(a.value), BigInt(b.value)));

    const singleIdx = asc.findIndex((n) => BigInt(n.value) >= threshold);
    const singleSum: bigint | null = singleIdx >= 0 ? BigInt(asc[singleIdx]!.value) : null;

    const pair = candidates.length >= 2 ? smallestPairCover(asc, threshold) : null;
    const pairSum: bigint | null = pair
        ? BigInt(asc[pair[0]]!.value) + BigInt(asc[pair[1]]!.value)
        : null;

    const useSingle = singleSum !== null && (pairSum === null || singleSum <= pairSum);
    const usePair = !useSingle && pairSum !== null;

    if (useSingle) {
        const pivot = singleSum!;
        const bucket = collectBucket(asc, singleIdx, pivot, bucketPct);
        // `collectBucket` always contains `asc[singleIdx]`, and `rng()` is in
        // [0, 1), so the index is in range.
        const pick = bucket[Math.floor(rng() * bucket.length)]!;
        return {
            plan: "direct",
            notes: [pick],
            sum: branded<CircuitAmount>(BigInt(pick.value)),
        };
    }

    if (usePair) {
        const tied = collectPairBucket(asc, threshold, pairSum!, bucketPct);
        const chosen = tied[Math.floor(rng() * tied.length)]!;
        const [ia, ib] = chosen;
        const a = asc[ia]!;
        const b = asc[ib]!;
        return {
            plan: "direct",
            notes: [a, b],
            sum: branded<CircuitAmount>(BigInt(a.value) + BigInt(b.value)),
        };
    }

    const total = candidates.reduce((s, n) => s + BigInt(n.value), 0n);
    if (total >= threshold && candidates.length >= 2) {
        const [first, second] = [asc[0]!, asc[1]!];
        return {
            plan: "consolidate-first",
            consolidate: [first, second],
            consolidateSum: branded<CircuitAmount>(BigInt(first.value) + BigInt(second.value)),
            targetWithFee: branded<CircuitAmount>(threshold),
        };
    }

    throw new SelectionError(
        `insufficient unspent value for asset ${asset}: have ${total}, need ${threshold}`,
        { asset },
    );
}

function collectBucket(
    asc: StoredNote[],
    startIdx: number,
    pivot: bigint,
    bucketPct: number,
): StoredNote[] {
    const lo = mulFloat(pivot, 1 - bucketPct);
    const hi = mulFloat(pivot, 1 + bucketPct);
    const out: StoredNote[] = [];
    for (let i = startIdx; i < asc.length; i++) {
        const n = asc[i]!;
        const v = BigInt(n.value);
        if (v >= lo && v <= hi) out.push(n);
        if (v > hi) break;
    }
    return out;
}

function smallestPairCover(asc: StoredNote[], threshold: bigint): [number, number] | null {
    let best: [number, number] | null = null;
    let bestSum: bigint | null = null;
    for (let i = 0; i < asc.length - 1; i++) {
        const vi = BigInt(asc[i]!.value);
        for (let j = i + 1; j < asc.length; j++) {
            const sum = vi + BigInt(asc[j]!.value);
            if (sum >= threshold) {
                if (bestSum === null || sum < bestSum) {
                    bestSum = sum;
                    best = [i, j];
                }
                break;
            }
        }
    }
    return best;
}

function collectPairBucket(
    asc: StoredNote[],
    threshold: bigint,
    target: bigint,
    bucketPct: number,
): [number, number][] {
    const lo = mulFloat(target, 1 - bucketPct);
    const hi = mulFloat(target, 1 + bucketPct);
    const out: [number, number][] = [];
    for (let i = 0; i < asc.length - 1; i++) {
        const vi = BigInt(asc[i]!.value);
        for (let j = i + 1; j < asc.length; j++) {
            const sum = vi + BigInt(asc[j]!.value);
            if (sum < threshold) continue;
            if (sum >= lo && sum <= hi) out.push([i, j]);
            if (sum > hi) break;
        }
    }
    return out.length > 0 ? out : [[0, 0]];
}

function mulFloat(v: bigint, f: number): bigint {
    const scaled = BigInt(Math.round(f * 1_000_000));
    return (v * scaled) / 1_000_000n;
}

function cmp(a: bigint, b: bigint): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

/** Pluggable selection strategy passed via `WalletConfig.selector`. */
export interface CoinSelector {
    select(
        all: readonly StoredNote[],
        asset: AssetId,
        target: CircuitAmount,
        opts?: SelectOpts,
    ): SelectionResult;
}

/** Smallest-First with Random Tiebreak. */
export class SfrtCoinSelector implements CoinSelector {
    select(
        all: readonly StoredNote[],
        asset: AssetId,
        target: CircuitAmount,
        opts?: SelectOpts,
    ): SelectionResult {
        return selectNotes(all, asset, target, opts);
    }
}
