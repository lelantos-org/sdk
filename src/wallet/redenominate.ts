// Re-denomination: reshape off-ladder notes into ladder amounts by
// self-transfer, so a later withdrawal has a denomination to spend exactly.
//
// Lives apart from `Wallet` because it is an algorithm over the wallet's own
// public API — notes in, transfers out — not a piece of wallet state. The host
// interface below is what it actually needs, which is also what makes it
// testable without a wasm-backed wallet.

import type { CircuitAmount, ShieldedAddress } from "../core/brand.js";
import { branded } from "../core/brand.js";
import { descendingAtMost, isDenomination, type Ladder } from "../core/denominations.js";
import { getLogger } from "../log/logger.js";
import type { NotesFilter, TransferOptions, TransferResult, WalletNote } from "./api.js";
import type { AssetInfo } from "./assets/index.js";

const log = getLogger("lelantos:wallet");

/**
 * Denominations tried per round before the batch is abandoned.
 *
 * More than one because the relayer's fee comes out of the same cover, so the
 * largest denomination a batch can reach frequently leaves nothing to pay it
 * with; three covers the 2×/2.5× steps of the ladder without proving against
 * hopeless targets indefinitely.
 */
const LADDER_RETRY_STEPS = 3;

/** Rounds {@link redenominate} runs unless told otherwise. */
export const DEFAULT_REDENOMINATE_ROUNDS = 4;

/** The slice of `Wallet` re-denomination drives. */
export interface RedenominateHost {
    /** Own shielded address — every transfer here is to self. */
    readonly address: ShieldedAddress;
    /** Input arity of the configured circuit: the batch size per round. */
    readonly maxInputs: number;
    notes(filter: NotesFilter): WalletNote[];
    transfer(args: TransferOptions): Promise<TransferResult>;
    awaitCommitments(cms: string[]): Promise<unknown>;
}

/**
 * Reshape this asset's off-ladder notes into ladder denominations.
 *
 * Returns the number of rounds that landed. Each round self-transfers up to
 * `maxInputs` off-ladder notes into the largest denomination they can reach;
 * a round that cannot place anything ends the loop rather than throwing,
 * because a partially-tidied note set is a strictly better position than the
 * one it started from.
 */
export async function redenominate(
    host: RedenominateHost,
    info: AssetInfo,
    opts: { maxRounds?: number } = {},
): Promise<number> {
    // Empty when the token has no ladder, or when the wallet opted out via
    // `WalletConfig.denominations` — either way there is nothing to conform to.
    if (info.ladder.length === 0) return 0;

    const maxRounds = opts.maxRounds ?? DEFAULT_REDENOMINATE_ROUNDS;
    let rounds = 0;
    while (rounds < maxRounds && (await round(host, info.id, info.ladder))) rounds++;
    return rounds;
}

/**
 * One re-denomination round: reshape up to `maxInputs` off-ladder notes.
 *
 * `true` when a transfer landed and another round is worth attempting;
 * `false` when there is nothing left to do, or nothing that can be done.
 */
async function round(host: RedenominateHost, asset: bigint, ladder: Ladder): Promise<boolean> {
    const offLadder = host
        .notes({ asset, spent: false })
        .filter((n) => n.value > 0n && !isDenomination(n.value, ladder))
        .slice(0, host.maxInputs);
    if (offLadder.length === 0) return false;

    const total = offLadder.reduce((sum, n) => sum + n.value, 0n);
    const only = offLadder.map((n) => n.id);

    // The payee note of a self-transfer is ours too, so it wants to be a
    // denomination like the change is; `splitChange` handles the rest.
    //
    // Largest first, but with fallbacks: the relayer's fee comes out of
    // this same cover, so the largest denomination `total` can reach
    // usually leaves no room for it. That is the common case, not the
    // exceptional one — stopping at the first refusal would make this a
    // no-op almost every time.
    for (const target of descendingAtMost(total, ladder, LADDER_RETRY_STEPS)) {
        try {
            const result = await host.transfer({
                to: host.address,
                amount: branded<CircuitAmount>(target),
                asset,
                selectOpts: { only, maxInputs: host.maxInputs },
                autoConsolidate: false,
            });
            await host.awaitCommitments([...result.ownCommitments]);
            return true;
        } catch (err) {
            log.debug("redenominate: target did not fit, stepping down", {
                asset: asset.toString(),
                target: target.toString(),
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    // Either nothing on the ladder is small enough to place, or every
    // candidate was refused. Retrying next round would prove against the
    // same cover it already could not afford.
    return false;
}
