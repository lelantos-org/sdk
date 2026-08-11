// Pluggable encrypted-note feed.

import type { MerkleProof } from "../crypto/merkle.js";
import type { FmdClient, FmdNoteOut } from "../services/fmd-server/client.js";
import type { ScanInput } from "../sync/scan.js";

export interface ListNotesOpts {
    limit?: number;
    after?: number;
}

/** Minimal Jubjub interface needed by note sources. */
export type JubjubPacker = { packPoint: (p: [bigint, bigint]) => Uint8Array };

/**
 * Source of encrypted notes. Merkle paths are computed locally via
 * `TreeStore`, and the spent set via `NullifierStore` — neither is a query a
 * note source answers, because both would name a specific note to the server.
 */
export interface NoteSource {
    listNotes(opts?: ListNotesOpts): Promise<ScanInput[]>;
}

export type { MerkleProof };

// ─── internal helpers ────────────────────────────────────────────────────────

function toScanInput(J: JubjubPacker, n: FmdNoteOut): ScanInput {
    return {
        ciphertext: n.ciphertext,
        epk: J.packPoint(n.ephPub),
        cm: n.cm,
        leafIndex: n.leafIndex,
    };
}

// ─── implementations ─────────────────────────────────────────────────────────

/** Default `NoteSource` against fmd-webserver — pulls the full note firehose. */
export class FmdNoteSource implements NoteSource {
    constructor(
        private readonly fmd: FmdClient,
        private readonly J: JubjubPacker,
    ) {}

    async listNotes(opts: ListNotesOpts = {}): Promise<ScanInput[]> {
        const rows = await this.fmd.listNotes(opts);
        return rows.map((n) => toScanInput(this.J, n));
    }
}

/**
 * `NoteSource` backed by `/v1/matches`: server-side FMD-filtered subset.
 * Trades anonymity (server learns the FP set bound by `gamma`) for bandwidth.
 *
 * `token` is the capability the caller registered with
 * `FmdClient.createSubscription`. It is the only handle to the subscription,
 * and need not be persisted: `deriveSubscriptionToken` regenerates it from
 * `ivk`.
 */
export class FmdMatchesNoteSource implements NoteSource {
    constructor(
        private readonly fmd: FmdClient,
        private readonly J: JubjubPacker,
        private readonly token: string,
    ) {}

    async listNotes(opts: ListNotesOpts = {}): Promise<ScanInput[]> {
        const rows = await this.fmd.listMatches({ token: this.token, ...opts });
        return rows.map((n) => toScanInput(this.J, n));
    }
}
