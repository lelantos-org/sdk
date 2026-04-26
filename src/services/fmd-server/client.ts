// Typed fmd-webserver HTTP client.
//
// Backend hex inconsistency: /v1/path + /v1/tree-state return 0x-hex;
// /v1/notes returns BARE hex (no 0x) for cm + ciphertext.

import { bigintFrom, int, mapArr, obj } from "../../core/decode.js";
import { fieldToBytes32 } from "../../core/hex.js";
import { createJsonClient, type HttpClientOptions, type JsonClient } from "../../core/http.js";
import type { Field } from "../../crypto/index.js";

export interface FmdPath {
    leafIndex: number;
    pathElements: Field[][];
    pathIndices: number[];
    root: Field;
}

export interface FmdTreeState {
    leafCount: number;
    root: Field;
    frontier: Field[][];
}

export interface FmdNoteOut {
    id: number;
    leafIndex: number;
    commitmentHex: string; // BARE hex (no 0x)
    ciphertextHex: string; // BARE hex (no 0x)
    ephPubX: string; // decimal
    ephPubY: string; // decimal
    blockNumber?: number;
    chainId?: number;
}

/** Server-side FMD-filtered note. Wire field `note_id` normalised to `id`. */
export interface FmdMatchOut extends FmdNoteOut {}

export interface SubscriptionOut {
    id: number;
    detectionKeyHex: string;
    gamma: number;
    active: boolean;
}

export interface CommitmentChunkEntry {
    leafIndex: number;
    cmHex: string;
    cvDepX: string;
    cvDepY: string;
}

export interface CommitmentChunkOut {
    chunkId: number;
    entries: CommitmentChunkEntry[];
    isComplete: boolean;
}

export interface CreateSubscriptionInput {
    detectionKeyHex: string;
    gamma: number;
}

export class FmdClient {
    private readonly json: JsonClient;

    constructor(
        baseUrl: string,
        private readonly chainId: bigint,
        opts: HttpClientOptions = {},
    ) {
        // `chainId` rides every request; callers never pass it.
        this.json = createJsonClient(
            baseUrl,
            { timeout: "FMD_TIMEOUT", failure: "FMD_FAILED" },
            { ...opts, defaultParams: { chainId: String(chainId) } },
        );
    }

    async fetchPath(cmHex: string): Promise<FmdPath> {
        const raw = await this.json.get<unknown>(`/v1/path/${encodeURIComponent(cmHex)}`);
        const d = obj(raw, "$");
        return {
            leafIndex: int(d.leafIndex, "$.leafIndex"),
            pathElements: mapArr(d.pathElementsHex, "$.pathElementsHex", (lvl, p) =>
                mapArr(lvl, p, bigintFrom),
            ),
            pathIndices: mapArr(d.pathIndices, "$.pathIndices", int),
            root: bigintFrom(d.rootHex, "$.rootHex"),
        };
    }

    async fetchTreeState(): Promise<FmdTreeState> {
        const d = obj(await this.json.get<unknown>("/v1/tree-state"), "$");
        return {
            leafCount: int(d.leafCount, "$.leafCount"),
            root: bigintFrom(d.rootHex, "$.rootHex"),
            frontier: mapArr(d.frontierHex, "$.frontierHex", (lvl, p) =>
                mapArr(lvl, p, bigintFrom),
            ),
        };
    }

    listNotes(opts?: { limit?: number; after?: number }): Promise<FmdNoteOut[]> {
        return this.json.get<FmdNoteOut[]>("/v1/notes", {
            params: { limit: opts?.limit, after: opts?.after },
        });
    }

    /** Server-side FMD-filtered notes for a registered subscription. */
    async listMatches(opts: {
        subscription: number;
        limit?: number;
        after?: number;
    }): Promise<FmdMatchOut[]> {
        const rows = await this.json.get<Array<{ noteId: number } & Omit<FmdMatchOut, "id">>>(
            "/v1/matches",
            {
                params: {
                    subscription: opts.subscription,
                    limit: opts.limit,
                    after: opts.after,
                },
            },
        );
        return rows.map(({ noteId, ...rest }) => ({ id: noteId, ...rest }));
    }

    /** Batch query on-chain spent-nullifier set. Server caps at 1024 per request. */
    async spentSet(nfs: bigint[]): Promise<Set<bigint>> {
        if (nfs.length === 0) return new Set();
        const nullifiers = nfs.map(fieldToBytes32);
        const out = obj(
            await this.json.post<unknown>("/v1/spent", {
                chainId: Number(this.chainId),
                nullifiers,
            }),
            "$",
        );
        return new Set(mapArr(out.spent, "$.spent", bigintFrom));
    }

    async fetchCommitmentChunk(chunkId: number): Promise<CommitmentChunkOut> {
        return this.json.get<CommitmentChunkOut>(`/v1/commitments/chunk/${chunkId}`);
    }

    listSubscriptions(): Promise<SubscriptionOut[]> {
        return this.json.get<SubscriptionOut[]>("/v1/subscriptions");
    }

    createSubscription(input: CreateSubscriptionInput): Promise<SubscriptionOut> {
        return this.json.post<SubscriptionOut>("/v1/subscriptions", input);
    }

    async deleteSubscription(id: number): Promise<void> {
        await this.json.del(`/v1/subscriptions/${id}`);
    }
}
