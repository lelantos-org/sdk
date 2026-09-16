// Re-denomination: reshape off-ladder notes into ladder amounts by self-transfer, so a later
// withdrawal can spend a denomination exactly.
//
// An algorithm over a narrow `RedenominateHost`, not wallet state, so it tests without a
// wasm-backed wallet.

import {
    InsufficientBalanceError,
    InsufficientCoverError,
    NotesHeldError,
} from "../../errors/funds.js";
import { getLogger } from "../../log/logger.js";
import { descendingAtMost, isDenomination, type Ladder } from "../../protocol/denominations.js";
import type { AssetInfo } from "../assets/index.js";
import { awaitOwnNotes, type SelfTransferHost, selfTransfer } from "../tx/self-transfer.js";
import type { NotesFilter } from "../types/options.js";
import type { TransferResult, WalletNote } from "../types/results.js";

const log = getLogger("lelantos:wallet");

/**
 * Denominations tried per round before the batch is abandoned.
 *
 * The relayer's fee comes out of the same cover, so the largest reachable denomination often
 * leaves nothing for the fee; three steps cover the ladder's 2×/2.5× ratios while bounding
 * attempts against unreachable targets.
 */
const LADDER_RETRY_STEPS = 3;

/** Rounds {@link redenominate} runs unless told otherwise. */
const DEFAULT_REDENOMINATE_ROUNDS = 4;

/** A cover failure for this target: a smaller denomination may still fit. */
function doesNotFit(err: unknown): err is Error {
    return (
        err instanceof InsufficientCoverError ||
        err instanceof InsufficientBalanceError ||
        err instanceof NotesHeldError
    );
}

/** The slice of a wallet re-denomination drives. `maxInputs` is the batch size per round. */
export interface RedenominateHost extends SelfTransferHost {
    notes(filter: NotesFilter): WalletNote[];
}

/**
 * Reshape this asset's off-ladder notes into ladder denominations.
 *
 * Returns the number of successful rounds. Each round self-transfers up to `maxInputs` off-ladder
 * notes into the largest denomination they can reach. A round that places nothing ends the loop
 * without throwing, since a partially reshaped note set is still an improvement.
 */
export async function redenominate(
    host: RedenominateHost,
    info: AssetInfo,
    opts: { maxRounds?: number } = {},
): Promise<number> {
    // Empty when the token has no ladder or the wallet opted out via `WalletConfig.denominations`.
    if (info.ladder.length === 0) return 0;

    const maxRounds = opts.maxRounds ?? DEFAULT_REDENOMINATE_ROUNDS;
    let rounds = 0;
    while (rounds < maxRounds && (await round(host, info.id, info.ladder))) rounds++;
    return rounds;
}

/**
 * One re-denomination round: reshape up to `maxInputs` off-ladder notes.
 *
 * Returns `true` when a transfer landed and another round may help; `false` when no off-ladder
 * notes remain or none can be placed.
 */
async function round(host: RedenominateHost, asset: bigint, ladder: Ladder): Promise<boolean> {
    const offLadder = host
        .notes({ asset, spent: false })
        .filter((n) => n.value > 0n && !isDenomination(n.value, ladder))
        .slice(0, host.maxInputs);
    if (offLadder.length === 0) return false;

    const total = offLadder.reduce((sum, n) => sum + n.value, 0n);
    const only = offLadder.map((n) => n.id);

    // The payee note of a self-transfer is also owned, so it should be a denomination, as the
    // change is; `splitChange` handles the remainder.
    //
    // Targets are tried largest first with fallbacks: the relayer's fee comes out of the same
    // cover, so the largest denomination `total` can reach usually leaves no room for it.
    for (const target of descendingAtMost(total, ladder, LADDER_RETRY_STEPS)) {
        let result: TransferResult;
        try {
            result = await selfTransfer(host, { asset, amount: target, only });
        } catch (err) {
            // Only "this target does not fit these notes" steps down. Anything else (the relayer
            // refusing, a network or prover failure) would fail every smaller target the same way,
            // and swallowing it would report a round that never ran as a finished reshape.
            if (!doesNotFit(err)) throw err;
            log.debug("redenominate: target did not fit, stepping down", {
                asset: asset.toString(),
                target: target.toString(),
                error: err.message,
            });
            continue;
        }
        // Outside the try: the transfer has landed, so a failure here must not step down and send
        // a second one.
        await awaitOwnNotes(host, result);
        return true;
    }
    // No ladder amount fits or every candidate was refused; another round would retry the same
    // cover.
    return false;
}
