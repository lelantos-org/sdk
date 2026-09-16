// The selector withdrawals use: SFRT, but taking a zero-change cover when the
// wallet holds one.

import type { AssetId, CircuitAmount } from "../../core/brand.js";
import type { StoredNote } from "../notes/note-store.js";
import { exactCover } from "./exact-cover.js";
import { SfrtCoinSelector } from "./sfrt.js";
import type { CoinSelector, SelectionResult, SelectOpts } from "./types.js";

/**
 * SFRT, preferring a zero-change cover when one exists.
 *
 * Wraps the inner selector: dust thresholds, cooldowns, reservations and the
 * consolidate-first fallback are unaffected; only an exact payment of the
 * target is intercepted.
 *
 * Intended for denominated withdrawals. An exactly covered denomination
 * produces no change note, so nothing needs re-splitting, without the selector
 * needing to know the ladder.
 */
export class DenominationCoinSelector implements CoinSelector {
    constructor(private readonly inner: CoinSelector = new SfrtCoinSelector()) {}

    select(
        all: readonly StoredNote[],
        asset: AssetId,
        target: CircuitAmount,
        opts: SelectOpts = {},
    ): SelectionResult {
        return exactCover(all, asset, target, opts) ?? this.inner.select(all, asset, target, opts);
    }
}
