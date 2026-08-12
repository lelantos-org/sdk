// The persisted note schema.
//
// Lives at tier 0 because it is pure data with no dependencies, and both the
// note store (which owns it) and `InsufficientCoverError` (which carries it)
// need to name it. `wallet/note-store.ts` re-exports these.

/** JSON-safe wire/storage shape. BigInts as decimal strings, `cm` as 0x-hex (32 B). */
export interface StoredNote {
    id: string;
    asset: string; // bigint as decimal string
    value: string;
    rho: string;
    rcm: string;
    /**
     * Deposit-anchor Pedersen blinder. Required at spend to recompute
     * `cv_dep = value · V^asset + rcv_dep · H` and the leaf hash.
     */
    rcvDep: string;
    cm: string; // 0x-hex 32 B
    leafIndex: number;
    spent: boolean;
    discoveredAt: string;
    /**
     * Block of first observation. Drives the selector spend cooldown that
     * breaks same-block change-link heuristics. Skipped when absent.
     */
    firstSeenBlock?: number | undefined;
}

/** Decoded shape with native BigInts. */
export interface NoteRecord {
    id: string;
    asset: bigint;
    value: bigint;
    rho: bigint;
    rcm: bigint;
    rcvDep: bigint;
    cm: string; // 0x-hex 32 B
    leafIndex: number;
    spent: boolean;
    discoveredAt: string;
    firstSeenBlock?: number | undefined;
}

export function decodeStoredNote(s: StoredNote): NoteRecord {
    return {
        id: s.id,
        asset: BigInt(s.asset),
        value: BigInt(s.value),
        rho: BigInt(s.rho),
        rcm: BigInt(s.rcm),
        rcvDep: BigInt(s.rcvDep),
        cm: s.cm,
        leafIndex: s.leafIndex,
        spent: s.spent,
        discoveredAt: s.discoveredAt,
        firstSeenBlock: s.firstSeenBlock,
    };
}
