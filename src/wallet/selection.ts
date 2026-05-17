// Coin selector: SFRT — Smallest-First with Random Tiebreak.

import { SelectionError } from "./errors.js";
import type { StoredNote } from "./note-store.js";

export interface SelectOpts {
    /// Cover threshold becomes `target + fee`. Default 0.
    fee?: bigint;
    /// Notes with value < dustThreshold are excluded. Recommended: `2 * marginalFee`.
    dustThreshold?: bigint;
    /// Minimum age (blocks) before spendable. Requires `tipBlock` and
    /// per-note `firstSeenBlock`; otherwise no-op.
    cooldownBlocks?: number;
    tipBlock?: number;
    /// Tiebreak shuffle width: notes within `(1 ± bucketPct) * pivot`. Default 0.05.
    bucketPct?: number;
    /// Injectable rng for tests. Returns float in [0, 1).
    rng?: () => number;
}

export interface DirectSelection {
    plan: "direct";
    notes: StoredNote[];
    sum: bigint;
}

export interface ConsolidateFirst {
    plan: "consolidate-first";
    /// Two smallest spendable notes — caller self-spends them, retries after sync.
    consolidate: StoredNote[];
    consolidateSum: bigint;
    /// `target + fee`.
    targetWithFee: bigint;
}

export type SelectionResult = DirectSelection | ConsolidateFirst;

/** @internal */
/// Pick up to 2 unspent notes for `asset` summing to ≥ `target + fee` via SFRT.
///
/// Rationale: largest-first leaves a value-ordering fingerprint (Tramèr USENIX'24);
/// randomized tiebreak restores indistinguishability (Chen & Bonneau FC'25);
/// smallest-pair drains dust so wallet note count shrinks over time.
export function selectNotes(
    all: StoredNote[],
    asset: bigint,
    target: bigint,
    opts: SelectOpts = {},
): SelectionResult {
    const fee = opts.fee ?? 0n;
    const dust = opts.dustThreshold ?? 0n;
    const cooldown = opts.cooldownBlocks ?? 0;
    const tip = opts.tipBlock;
    const bucketPct = opts.bucketPct ?? 0.05;
    const rng = opts.rng ?? defaultRng;
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
    const singleSum: bigint | null = singleIdx >= 0 ? BigInt(asc[singleIdx].value) : null;

    const pair = candidates.length >= 2 ? smallestPairCover(asc, threshold) : null;
    const pairSum: bigint | null = pair
        ? BigInt(asc[pair[0]].value) + BigInt(asc[pair[1]].value)
        : null;

    const useSingle = singleSum !== null && (pairSum === null || singleSum <= pairSum);
    const usePair = !useSingle && pairSum !== null;

    if (useSingle) {
        const pivot = singleSum!;
        const bucket = collectBucket(asc, singleIdx, pivot, bucketPct);
        const pick = bucket[Math.floor(rng() * bucket.length)];
        return { plan: "direct", notes: [pick], sum: BigInt(pick.value) };
    }

    if (usePair) {
        const tied = collectPairBucket(asc, threshold, pairSum!, bucketPct);
        const chosen = tied[Math.floor(rng() * tied.length)];
        return {
            plan: "direct",
            notes: [asc[chosen[0]], asc[chosen[1]]],
            sum: BigInt(asc[chosen[0]].value) + BigInt(asc[chosen[1]].value),
        };
    }

    const total = candidates.reduce((s, n) => s + BigInt(n.value), 0n);
    if (total >= threshold && candidates.length >= 2) {
        const consolidate = [asc[0], asc[1]];
        return {
            plan: "consolidate-first",
            consolidate,
            consolidateSum: BigInt(asc[0].value) + BigInt(asc[1].value),
            targetWithFee: threshold,
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
        const v = BigInt(asc[i].value);
        if (v >= lo && v <= hi) out.push(asc[i]);
        if (v > hi) break;
    }
    return out;
}

function smallestPairCover(asc: StoredNote[], threshold: bigint): [number, number] | null {
    let best: [number, number] | null = null;
    let bestSum: bigint | null = null;
    for (let i = 0; i < asc.length - 1; i++) {
        const vi = BigInt(asc[i].value);
        for (let j = i + 1; j < asc.length; j++) {
            const sum = vi + BigInt(asc[j].value);
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
        const vi = BigInt(asc[i].value);
        for (let j = i + 1; j < asc.length; j++) {
            const sum = vi + BigInt(asc[j].value);
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

function defaultRng(): number {
    if (!globalThis.crypto?.getRandomValues) {
        throw new Error("Web Crypto API not available; pass an rng in SelectOpts");
    }
    const buf = new Uint8Array(7);
    globalThis.crypto.getRandomValues(buf);
    let n = 0;
    for (const b of buf) n = n * 256 + b;
    return n / 2 ** 56;
}

/// Pluggable selection strategy passed via `WalletConfig.selector`.
export interface CoinSelector {
    select(all: StoredNote[], asset: bigint, target: bigint, opts?: SelectOpts): SelectionResult;
}

/// Smallest-First with Random Tiebreak.
export class SfrtCoinSelector implements CoinSelector {
    select(all: StoredNote[], asset: bigint, target: bigint, opts?: SelectOpts): SelectionResult {
        return selectNotes(all, asset, target, opts);
    }
}
