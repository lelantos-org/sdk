// Auto-consolidation: merge the notes a `consolidate-first` selection named into
// one, then wait until the merged note is spendable.
//
// Returning before the change note is stored and past its spend cooldown would
// leave the caller's retry selecting from the same note set that could not
// cover the target.

import { sleep } from "../../core/async.js";
import { type AssetId, branded, type CircuitAmount } from "../../core/brand.js";
import { InsufficientBalanceError, NotesHeldError } from "../../errors/funds.js";
import { getLogger } from "../../log/logger.js";
import type { AwaitCommitmentsResult } from "../notes/note-cache.js";
import type { StoredNote } from "../notes/note-store.js";
import { type ConsolidateFirst, DEFAULT_COOLDOWN_BLOCKS } from "../selection/index.js";
import { awaitOwnNotes, type SelfTransferHost, selfTransfer } from "../tx/self-transfer.js";

const log = getLogger("lelantos:wallet");

/**
 * How long to wait for a consolidated note to clear its spend cooldown.
 *
 * The merged note is unspendable until it is `cooldownBlocks` old. Exceeded
 * (and logged) when the chain is not producing blocks.
 */
const COOLDOWN_WAIT_MS = 30_000;

/**
 * Poll interval while waiting.
 *
 * `ViemChainAdapter.blockNumber()` reads the chain on every call unless the
 * adapter was built with a `cacheTimeMs`.
 */
const COOLDOWN_POLL_MS = 1_000;

/** The slice of a wallet consolidation drives. */
export interface ConsolidateHost extends SelfTransferHost {
    /** Chain tip, when the adapter can report one. */
    blockNumber(): Promise<number | undefined>;
    /** The in-memory note set, which carries `firstSeenBlock`. */
    storedNotes(): readonly StoredNote[];
    /**
     * `spendableMax` over the notes `only` names: the most one transfer can send out of them,
     * and the relayer fee already reserved from it.
     *
     * The merge amount is derived from this rather than from the notes' sum, because the fee is
     * paid out of those same notes. A self-transfer names no fee asset, so the fee is charged in
     * `asset` (or not at all) and `fee` is `0n` whenever nothing is reserved here.
     */
    spendableMax(asset: bigint, only: readonly string[]): Promise<{ max: bigint; fee: bigint }>;
}

/**
 * Self-spend the notes `selection` named into one change note.
 *
 * Sends one unit less than the pinned notes can move, so a 1-unit change note
 * is produced (some selectors discard zero-value change).
 *
 *   * **The amount is fee-aware.** The relayer is paid out of the pinned notes
 *     too, so the merge asks for `spendableMax` (the sum less the fee) rather
 *     than the sum: `consolidateSum - 1n` needs `consolidateSum - 1n + fee`
 *     from notes worth `consolidateSum`, which fails for any fee above one
 *     unit.
 *   * **The notes are pinned.** `only` restricts the inner selector to the ids
 *     the caller named; given only an amount, it could cover the target with a
 *     single large note and merge none of the dust.
 *   * **The change note is awaited.** `sync()` returns after one scan pass,
 *     typically before the relayer's tx is mined, so the store may not yet
 *     contain the merged note.
 *   * **Its cooldown is awaited.** A note is unspendable until
 *     `tip - firstSeenBlock >= cooldownBlocks`. The cooldown is waited out
 *     instead of lowered for the retry, because spending a change note in the
 *     block that created it links the two for anyone counting leaves.
 */
export async function autoConsolidate(
    host: ConsolidateHost,
    asset: bigint,
    selection: ConsolidateFirst,
): Promise<void> {
    const sum = selection.consolidateSum;
    const only = selection.consolidate.map((n) => n.id);
    const { max, fee } = await host.spendableMax(asset, only);
    if (max <= 0n) {
        // The fee would eat the merge. Refused here rather than sent: the transfer would ask its
        // own pinned notes for more than they hold and fail one quote later with the same code,
        // and no amount of retrying or consolidating changes it.
        throw new InsufficientBalanceError(
            {
                asset: branded<AssetId>(asset),
                available: sum,
                required: branded<CircuitAmount>(fee + 1n),
            },
            { context: { op: "consolidate" }, details: { notes: only.length } },
        );
    }
    const result = await selfTransfer(host, { asset, amount: max > 1n ? max - 1n : max, only });
    const waited = await awaitOwnNotes(host, result);
    if (notSeen(waited)) {
        // The merge landed but its note is not stored yet, so the caller's retry would select from
        // the same notes that could not cover it and report insufficient cover, which is wrong.
        // The merged value is held, not missing: retrying once the indexer catches up succeeds.
        throw new NotesHeldError(
            {
                asset: branded<AssetId>(asset),
                required: sum,
                spendable: branded<CircuitAmount>(0n),
                held: {
                    reserved: { value: sum, count: waited.missing.length },
                    cooldown: { value: branded<CircuitAmount>(0n), count: 0 },
                    dust: { value: branded<CircuitAmount>(0n), count: 0 },
                },
            },
            {
                context: { op: "consolidate" },
                details: {
                    txHash: result.txHash,
                    missing: waited.missing.length,
                    attempts: waited.attempts,
                },
            },
        );
    }
    await awaitCooldown(host, asset, result.ownCommitments);
}

/** An `awaitCommitments` outcome other than every commitment seen. */
function notSeen(r: unknown): r is AwaitCommitmentsResult {
    return (
        typeof r === "object" &&
        r !== null &&
        "status" in r &&
        (r as AwaitCommitmentsResult).status !== "seen"
    );
}

/**
 * Block until the merged note has aged past the selector's spend cooldown.
 *
 * Measured against the note's `firstSeenBlock`, not a tip captured on entry:
 * after `awaitCommitments` the note is cached with its block recorded, and
 * indexing lag often means the tip is already far enough ahead, so no extra
 * block time is spent.
 *
 * Returns immediately when the adapter cannot report a block number or the
 * note has no `firstSeenBlock`; the selector's cooldown does not apply in
 * either case.
 */
async function awaitCooldown(
    host: ConsolidateHost,
    asset: bigint,
    cms: readonly string[],
): Promise<void> {
    const wanted = new Set(cms.map((c) => c.toLowerCase()));
    const bornAt = host
        .storedNotes()
        .filter((n) => wanted.has(n.cm.toLowerCase()))
        .map((n) => n.firstSeenBlock)
        .filter((b): b is number => b !== undefined);
    if (bornAt.length === 0) return;
    const spendableAt = Math.max(...bornAt) + DEFAULT_COOLDOWN_BLOCKS;

    for (let waited = 0; ; waited += COOLDOWN_POLL_MS) {
        const tip = await host.blockNumber();
        if (tip === undefined || tip >= spendableAt) return;
        if (waited >= COOLDOWN_WAIT_MS) break;
        await sleep(COOLDOWN_POLL_MS);
    }
    // Not fatal: the caller's next selection may exclude the note and report
    // insufficient cover. Logged because, on a chain not producing blocks,
    // this explains why consolidation appears to have no effect.
    log.warn("chain tip did not advance; a consolidated note may still be in cooldown", {
        asset: asset.toString(),
        waitedMs: COOLDOWN_WAIT_MS,
    });
}
