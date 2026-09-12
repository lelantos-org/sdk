// Auto-consolidation: merge the notes a `consolidate-first` selection named
// into one, then wait until that merged note is actually spendable.
//
// The waiting is the substance. A merge that returns before the change note is
// stored, or before it has cleared the spend cooldown, leaves the caller's
// retry selecting against the same note set that could not cover the target.

import { sleep } from "../core/async.js";
import { branded, type CircuitAmount, type ShieldedAddress } from "../core/brand.js";
import { getLogger } from "../log/logger.js";
import type { TransferOptions, TransferResult } from "./api.js";
import type { StoredNote } from "./note-store.js";
import { DEFAULT_COOLDOWN_BLOCKS, type SelectionResult } from "./selection/index.js";

const log = getLogger("lelantos:wallet");

/**
 * How long to wait for a consolidated note to clear its spend cooldown.
 *
 * The merged note is unspendable until it is `cooldownBlocks` old, so the
 * caller's retry is pointless before then. A chain that is not producing
 * blocks hits this and logs.
 */
const COOLDOWN_WAIT_MS = 30_000;

/**
 * Poll interval while waiting.
 *
 * Coarser than it looks: `ViemChainAdapter.blockNumber()` is cached for
 * `cacheTime` (4s by default), so most polls resolve from that cache rather
 * than the network.
 */
const COOLDOWN_POLL_MS = 1_000;

/** The slice of `Wallet` consolidation drives. */
export interface ConsolidateHost {
    /** Own shielded address — the merge is a self-transfer. */
    readonly address: ShieldedAddress;
    /** Input arity of the configured circuit: every slot is used to merge. */
    readonly maxInputs: number;
    /** Chain tip, when the adapter can report one. */
    blockNumber(): Promise<number | undefined>;
    /** The in-memory note set, which is what carries `firstSeenBlock`. */
    storedNotes(): readonly StoredNote[];
    transfer(args: TransferOptions): Promise<TransferResult>;
    awaitCommitments(cms: string[]): Promise<unknown>;
}

/**
 * Self-spend the notes `selection` named into one change note.
 *
 * Sends `consolidateSum - 1n` so a 1-unit change note pops out (some
 * selectors discard zero-value change).
 *
 * Three details are what make this actually merge, rather than appear to:
 *
 *   * **The notes are pinned.** Passing only an amount let the inner
 *     selector cover it however it liked — usually with one large note,
 *     merging none of the dust this was called to merge. `only` restricts
 *     it to exactly the ids the caller named.
 *   * **The change note is waited for.** `sync()` alone returns as soon as
 *     one scan pass completes, which is typically before the relayer's tx
 *     is mined, so the retry re-selected against a store that did not yet
 *     contain the merged note.
 *   * **Its cooldown is waited out.** A note is unspendable until
 *     `tip - firstSeenBlock >= cooldownBlocks`, so a merge is useless to
 *     the caller until a block has passed. Waiting here — rather than
 *     lowering the cooldown for the retry — keeps the property the
 *     cooldown exists for: spending a change note in the block that
 *     created it links the two for anyone counting leaves.
 */
export async function autoConsolidate(
    host: ConsolidateHost,
    asset: bigint,
    selection: Extract<SelectionResult, { plan: "consolidate-first" }>,
): Promise<void> {
    const target = branded<CircuitAmount>(
        selection.consolidateSum > 1n ? selection.consolidateSum - 1n : selection.consolidateSum,
    );
    const result = await host.transfer({
        to: host.address,
        amount: target,
        asset,
        selectOpts: {
            only: selection.consolidate.map((n) => n.id),
            // Merging, so use every slot the circuit provides.
            maxInputs: host.maxInputs,
        },
        // Inner call must NOT recurse.
        autoConsolidate: false,
    });
    await host.awaitCommitments([...result.ownCommitments]);
    await awaitCooldown(host, asset, result.ownCommitments);
}

/**
 * Block until the merged note has aged past the selector's spend cooldown.
 *
 * Measured against the note's own `firstSeenBlock`, not against a tip
 * captured on entry: `awaitCommitments` has already returned by this point,
 * so the note is in the cache with its block recorded, and indexing lag
 * often means the tip is *already* far enough ahead. Waiting on "the tip
 * moves once" instead would burn a block time the common case does not owe.
 *
 * Returns immediately when the adapter cannot report a block number, or
 * when the note carries no `firstSeenBlock` — the selector's cooldown is
 * inert in both cases, so there is nothing to wait for.
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
    // Not fatal: the caller's next selection simply may not see the note,
    // and it will report insufficient cover rather than doing something
    // wrong. Worth a line, because on a chain that is not producing blocks
    // this is the reason consolidation looks like it did nothing.
    log.warn("chain tip did not advance; a consolidated note may still be in cooldown", {
        asset: asset.toString(),
        waitedMs: COOLDOWN_WAIT_MS,
    });
}
