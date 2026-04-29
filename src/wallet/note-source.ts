// Pluggable encrypted-note feed + merkle-path provider. Default uses the
// fmd-webserver REST API; apps can plug in indexers, P2P relays, mocks.
//
// Returns SDK-canonical shapes (`ScanInput`, `FmdPath`) so the Wallet's
// scanning + spending paths don't care where the data came from.

import type { Field } from "../crypto/index";
import type { ScanInput } from "../sync";
import { FmdClient } from "./fmd-client";

export interface MerklePath {
    leafIndex: number;
    pathElements: Field[][];
    pathIndices: number[];
    /// Recomputed root from the path. Caller MUST verify it's a known root
    /// on chain before trusting it for spending.
    root: Field;
}

export interface ListNotesOpts {
    limit?: number;
    after?: number;
}

/// Source of encrypted notes + merkle paths. Implementations bridge a
/// concrete indexing service (fmd-webserver, custom p2p, mock) to the
/// shapes the Wallet's scan + spend code consumes.
export interface NoteSource {
    listNotes(opts?: ListNotesOpts): Promise<ScanInput[]>;
    fetchPath(cmHex: string): Promise<MerklePath>;
}

function hexToBytes(h: string): Uint8Array {
    const s = h.startsWith("0x") ? h.slice(2) : h;
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
    return out;
}

function hexToBigint(h: string): bigint {
    return BigInt(h.startsWith("0x") ? h : "0x" + h);
}

/// Default `NoteSource` against fmd-webserver. Wraps `FmdClient` and
/// converts the wire shapes to `ScanInput` / `MerklePath`.
export class FmdNoteSource implements NoteSource {
    private readonly fmd: FmdClient;
    private readonly J: { packPoint: (p: [bigint, bigint]) => Uint8Array };

    constructor(args: {
        fmd: FmdClient;
        /// Need a Jubjub instance to pack the (x, y) → 32B `epk` form.
        J: { packPoint: (p: [bigint, bigint]) => Uint8Array };
    }) {
        this.fmd = args.fmd;
        this.J = args.J;
    }

    async listNotes(opts: ListNotesOpts = {}): Promise<ScanInput[]> {
        const rows = await this.fmd.listNotes(opts);
        return rows.map((n) => {
            const ephPub = this.J.packPoint([BigInt(n.ephPubX), BigInt(n.ephPubY)]);
            return {
                ciphertext: hexToBytes(n.ciphertextHex),
                epk: ephPub,
                cm: hexToBigint(n.commitmentHex),
                leafIndex: n.leafIndex,
            };
        });
    }

    async fetchPath(cmHex: string): Promise<MerklePath> {
        return this.fmd.fetchPath(cmHex);
    }
}
