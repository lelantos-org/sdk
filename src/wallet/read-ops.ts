// Cache reads: what a caller sees of the notes a wallet holds.
//
// Operations over a note set, so `Wallet` and `WatchWallet` return identical
// answers for identical notes. `./sync-ops.ts` covers the write side.

import { type AssetId, type AssetIdLike, branded, type CircuitAmount } from "../core/brand.js";
import type { StoredNote } from "./note-store.js";
import type { NotesFilter } from "./options.js";
import type { WalletNote } from "./result.js";
import { toWalletNote } from "./result-builder.js";

/** Omit a field to stop filtering on it; an empty filter passes everything. */
export function filterNotes(notes: readonly StoredNote[], filter: NotesFilter = {}): WalletNote[] {
    return notes
        .filter((n) => {
            if (filter.spent !== undefined && n.spent !== filter.spent) return false;
            if (filter.asset !== undefined && BigInt(n.asset) !== filter.asset) return false;
            return true;
        })
        .map(toWalletNote);
}

/**
 * Unspent total for one asset, in circuit units.
 *
 * A wallet that cannot recognise its own spends marks none spent, making this
 * the gross total received. See `ReadOnlyWalletApi.spentKnown`.
 */
export function balanceOf(notes: readonly StoredNote[], asset: AssetIdLike): CircuitAmount {
    return branded<CircuitAmount>(
        notes
            .filter((n) => !n.spent && BigInt(n.asset) === asset)
            .reduce((s, n) => s + BigInt(n.value), 0n),
    );
}

/** Unspent totals keyed by asset id — one pass for a multi-asset view. */
export function balancesOf(notes: readonly StoredNote[]): Map<AssetId, CircuitAmount> {
    const out = new Map<AssetId, CircuitAmount>();
    for (const n of notes) {
        if (n.spent) continue;
        const asset = branded<AssetId>(BigInt(n.asset));
        out.set(asset, branded<CircuitAmount>((out.get(asset) ?? 0n) + BigInt(n.value)));
    }
    return out;
}
