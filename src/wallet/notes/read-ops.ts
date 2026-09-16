// Read operations over a note set, shared so spending and watch-only wallets return identical results
// for identical notes. `./sync-ops.ts` covers the write side.

import {
    type AssetId,
    type AssetIdLike,
    branded,
    type CircuitAmount,
    type Hex32,
} from "../../core/brand.js";
import type { NotesFilter } from "../types/options.js";
import type { WalletNote } from "../types/results.js";
import type { StoredNote } from "./note-store.js";

/** `notePayload()` recomputes on each call. */
function toWalletNote(s: StoredNote): WalletNote {
    return {
        id: s.id,
        asset: branded<AssetId>(BigInt(s.asset)),
        value: branded<CircuitAmount>(BigInt(s.value)),
        spent: s.spent,
        ...(s.firstSeenBlock !== undefined ? { firstSeenBlock: s.firstSeenBlock } : {}),
        discoveredAt: s.discoveredAt,
        cm: branded<Hex32>(s.cm),
        notePayload: () => ({
            asset: branded<AssetId>(BigInt(s.asset)),
            value: branded<CircuitAmount>(BigInt(s.value)),
            rho: BigInt(s.rho),
            rcm: BigInt(s.rcm),
            rcvDep: BigInt(s.rcvDep),
        }),
    };
}

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
 * A wallet that cannot recognise its own spends marks none spent, so this is then the gross total
 * received. See `ReadOnlyWalletApi.spentKnown`.
 */
export function balanceOf(notes: readonly StoredNote[], asset: AssetIdLike): CircuitAmount {
    return branded<CircuitAmount>(
        notes
            .filter((n) => !n.spent && BigInt(n.asset) === asset)
            .reduce((s, n) => s + BigInt(n.value), 0n),
    );
}

/** Unspent totals keyed by asset id, computed in one pass. */
export function balancesOf(notes: readonly StoredNote[]): Map<AssetId, CircuitAmount> {
    const out = new Map<AssetId, CircuitAmount>();
    for (const n of notes) {
        if (n.spent) continue;
        const asset = branded<AssetId>(BigInt(n.asset));
        out.set(asset, branded<CircuitAmount>((out.get(asset) ?? 0n) + BigInt(n.value)));
    }
    return out;
}
