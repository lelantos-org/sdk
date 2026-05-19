// Pluggable encrypted-note feed.

import type { MerkleProof } from "../crypto/merkle.js";
import type { ScanInput } from "../sync/sync.js";
import type { FmdClient, FmdNoteOut } from "./fmd-client.js";

export interface ListNotesOpts {
    limit?: number;
    after?: number;
}

/// Minimal Jubjub interface needed by note sources.
export type JubjubPacker = { packPoint: (p: [bigint, bigint]) => Uint8Array };

/// Source of encrypted notes. Merkle paths are computed locally via TreeStore.
export interface NoteSource {
    listNotes(opts?: ListNotesOpts): Promise<ScanInput[]>;
    /// Returns the subset of `nfs` already consumed on chain.
    spentSet(nfs: bigint[]): Promise<Set<bigint>>;
}

export type { MerkleProof };

// ─── internal helpers ────────────────────────────────────────────────────────

function hexToBytes(h: string): Uint8Array {
    const s = h.startsWith("0x") ? h.slice(2) : h;
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
    return out;
}

function hexToBigint(h: string): bigint {
    return BigInt(h.startsWith("0x") ? h : `0x${h}`);
}

function toScanInput(J: JubjubPacker, n: FmdNoteOut): ScanInput {
    return {
        ciphertext: hexToBytes(n.ciphertextHex),
        epk: J.packPoint([BigInt(n.ephPubX), BigInt(n.ephPubY)]),
        cm: hexToBigint(n.commitmentHex),
        leafIndex: n.leafIndex,
    };
}

// ─── implementations ─────────────────────────────────────────────────────────

/// Default `NoteSource` against fmd-webserver — pulls the full note firehose.
export class FmdNoteSource implements NoteSource {
    constructor(
        private readonly fmd: FmdClient,
        private readonly J: JubjubPacker,
    ) {}

    async listNotes(opts: ListNotesOpts = {}): Promise<ScanInput[]> {
        const rows = await this.fmd.listNotes(opts);
        return rows.map((n) => toScanInput(this.J, n));
    }

    async spentSet(nfs: bigint[]): Promise<Set<bigint>> {
        return this.fmd.spentSet(nfs);
    }
}

/// `NoteSource` backed by `/v1/matches`: server-side FMD-filtered subset.
/// Trades anonymity (server learns the FP set bound by `gamma`) for bandwidth.
export class FmdMatchesNoteSource implements NoteSource {
    constructor(
        private readonly fmd: FmdClient,
        private readonly J: JubjubPacker,
        private readonly subscriptionId: number,
    ) {}

    async listNotes(opts: ListNotesOpts = {}): Promise<ScanInput[]> {
        const rows = await this.fmd.listMatches({ subscription: this.subscriptionId, ...opts });
        return rows.map((n) => toScanInput(this.J, n));
    }

    async spentSet(nfs: bigint[]): Promise<Set<bigint>> {
        return this.fmd.spentSet(nfs);
    }
}
