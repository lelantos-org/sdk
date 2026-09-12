// The selector withdrawals use: SFRT, but taking a zero-change cover when the
// wallet holds one.

import type { AssetId, CircuitAmount } from "../../core/brand.js";
import type { StoredNote } from "../note-store.js";
import { exactCover } from "./exact-cover.js";
import { SfrtCoinSelector } from "./sfrt.js";
import type { CoinSelector, SelectionResult, SelectOpts } from "./types.js";

/**
 * SFRT, preferring a zero-change cover when one exists.
 *
 * Wraps rather than replaces: everything SFRT does about dust thresholds,
 * cooldowns, reservations and the consolidate-first fallback is unchanged, and
 * this only intercepts the case where the wallet can pay the target exactly.
 *
 * Use it wherever withdrawals are denominated. A denomination that is covered
 * exactly produces no change note, so nothing has to land on the ladder and
 * nothing needs re-splitting later — the cheapest possible outcome, reached
 * without any knowledge of what the ladder is.
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
