// The persisted note schema. Pure data with no dependencies.

/** JSON-safe wire/storage shape. BigInts as decimal strings, `cm` as 0x-hex (32 B). */
export interface StoredNote {
    id: string;
    asset: string;
    value: string;
    rho: string;
    rcm: string;
    /** Diversifier of the address the note was sent to, decimal. `pk = Poseidon(TAG_PK, ivk, d)`. */
    d: string;
    cm: string;
    leafIndex: number;
    spent: boolean;
    discoveredAt: string;
    /**
     * Block of first observation. Drives the selector spend cooldown that
     * breaks same-block change-link heuristics. Skipped when absent.
     */
    firstSeenBlock?: number | undefined;
    /**
     * ISO timestamp of a spend of this note submitted without a known outcome. Selection skips
     * the note until the nullifier resolves the outcome or the reservation expires
     * (`SPEND_RESERVATION_MS`).
     *
     * `spent` is set only from evidence (a relayer acknowledgement, or the nullifier observed
     * on-chain) and is never cleared, so setting it for a submit whose response was lost could
     * leave an unspent note unreachable until the next wipe-and-rescan.
     */
    pendingSpendAt?: string | undefined;
}

/** The persisted notes file a `NoteStore` loads and saves. */
export interface NotesFile {
    version: 3;
    notes: StoredNote[];
    /**
     * Resume point for `syncWallet`: the highest source row id whose notes are accounted for.
     * Absent means start from the beginning, which is safe because scanning is idempotent.
     *
     * A `NoteStore` implementation must round-trip this; dropping it makes every sync re-scan
     * from zero.
     */
    cursor?: number;
}

/** Decoded shape with native BigInts. */
export interface NoteRecord {
    id: string;
    asset: bigint;
    value: bigint;
    rho: bigint;
    rcm: bigint;
    d: bigint;
    cm: string; // 0x-hex 32 B
    leafIndex: number;
    spent: boolean;
    discoveredAt: string;
    firstSeenBlock?: number | undefined;
    pendingSpendAt?: string | undefined;
}

export function decodeStoredNote(s: StoredNote): NoteRecord {
    return {
        id: s.id,
        asset: BigInt(s.asset),
        value: BigInt(s.value),
        rho: BigInt(s.rho),
        rcm: BigInt(s.rcm),
        d: BigInt(s.d),
        cm: s.cm,
        leafIndex: s.leafIndex,
        spent: s.spent,
        discoveredAt: s.discoveredAt,
        firstSeenBlock: s.firstSeenBlock,
        pendingSpendAt: s.pendingSpendAt,
    };
}
