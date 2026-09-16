// The persisted note schema.
//
// Pure data with no dependencies. `wallet/notes/note-store.ts` re-exports these. The
// `ConsolidateHint` that `InsufficientCoverError` carries lives in `errors/funds.ts`.

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
    /**
     * When a spend of this note was submitted without a known outcome, as an
     * ISO timestamp. Withholds the note from selection while it may already
     * be spent, without asserting that it is.
     *
     * `spent` is set only from evidence (a relayer acknowledgement, or the
     * nullifier observed on-chain) and is never cleared. A submit whose
     * response was lost has no evidence, and setting `spent` could leave an
     * unspent note unreachable until the next wipe-and-rescan, so the note is
     * reserved instead: selection skips it until the nullifier resolves the
     * outcome or the reservation expires. See `SPEND_RESERVATION_MS`.
     */
    pendingSpendAt?: string | undefined;
}

/** The persisted notes file a `NoteStore` loads and saves. */
export interface NotesFile {
    version: 1;
    notes: StoredNote[];
    /**
     * Resume point for `syncWallet`: the highest source row id whose notes are accounted for.
     * Absent means start from the beginning, which is safe because scanning is idempotent.
     *
     * A `NoteStore` implementation MUST round-trip this; dropping it makes every sync re-scan
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
    rcvDep: bigint;
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
        rcvDep: BigInt(s.rcvDep),
        cm: s.cm,
        leafIndex: s.leafIndex,
        spent: s.spent,
        discoveredAt: s.discoveredAt,
        firstSeenBlock: s.firstSeenBlock,
        pendingSpendAt: s.pendingSpendAt,
    };
}
