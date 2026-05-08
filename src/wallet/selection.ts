// Coin selector: SFRT — Smallest-First with Random Tiebreak.
//
// Lifted from the CLI; pure logic, browser-safe (uses Web Crypto for the
// default rng). Exposes `selectNotes` which the Wallet class wraps.

import { SelectionError } from "./errors.js";
import type { StoredNote } from "./note-store.js";

export interface SelectOpts {
    /// Fee added to target before selection. Caller supplies; selector treats
    /// `target + fee` as the cover threshold.
    fee?: bigint;
    /// Notes with value < dustThreshold are excluded from automatic selection.
    /// Default 0n. Recommended: `2 * marginalFee` (ZIP-317 style).
    dustThreshold?: bigint;
    /// Minimum age (in blocks) before a note becomes spendable. Mitigates
    /// same-block change-link heuristics. Requires `tipBlock` and per-note
    /// `firstSeenBlock` to take effect; otherwise no-op.
    cooldownBlocks?: number;
    tipBlock?: number;
    /// Width of the value-bucket used for randomized tiebreak. Notes whose
    /// value is within `(1 ± bucketPct) * pivot` are shuffled before pick.
    /// Default 0.05 (±5%).
    bucketPct?: number;
    /// Inject for deterministic tests. Returns float in [0, 1).
    rng?: () => number;
}

export interface DirectSelection {
    plan: "direct";
    notes: StoredNote[];
    sum: bigint;
}

export interface ConsolidateFirst {
    plan: "consolidate-first";
    /// Two smallest spendable notes for the asset. Caller should self-spend
    /// these (combine into a single larger note) and then retry the original
    /// target after the next sync.
    consolidate: StoredNote[];
    /// Sum of `consolidate`. Useful for telling the user how much would be
    /// freed up if they consolidate.
    consolidateSum: bigint;
    /// Original target the caller asked for (target + fee).
    targetWithFee: bigint;
}

export type SelectionResult = DirectSelection | ConsolidateFirst;

/// Pick up to 2 unspent notes for `asset` whose values sum to at least
/// `target + fee`. Strategy: SFRT — Smallest-First with Random Tiebreak.
///
/// 1. Single-cover: smallest note ≥ threshold; ties (within ±bucketPct)
///    shuffled.
/// 2. Two-cover: ascending sort, two-pointer scan for smallest-pair cover;
///    ties shuffled.
/// 3. If no 2-cover but sum-of-all ≥ threshold, return `consolidate-first`
///    plan naming the two smallest notes.
/// 4. If even sum-of-all < threshold, throw.
///
/// Rationale: largest-first leaves a value-ordering fingerprint across spends
/// (Tramèr USENIX'24); randomized tiebreak restores indistinguishability
/// (Chen & Bonneau FC'25); smallest-pair drains dust so wallet note count
/// shrinks over time (Penumbra planner approach).
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

// ---------- pluggable interface ----------

/// Strategy interface for coin selection. Apps can implement custom
/// strategies (largest-first, Penumbra planner, deterministic test stub)
/// and pass via `WalletConfig.selector`.
export interface CoinSelector {
    select(all: StoredNote[], asset: bigint, target: bigint, opts?: SelectOpts): SelectionResult;
}

/// Default — Smallest-First with Random Tiebreak.
export class SfrtCoinSelector implements CoinSelector {
    select(all: StoredNote[], asset: bigint, target: bigint, opts?: SelectOpts): SelectionResult {
        return selectNotes(all, asset, target, opts);
    }
}
