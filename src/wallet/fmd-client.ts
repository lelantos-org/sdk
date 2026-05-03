// Typed fmd-webserver HTTP client.
//
// Backend hex format inconsistency note:
//   /v1/path     and /v1/tree-state return 0x-prefixed hex
//   /v1/notes    returns BARE hex (no 0x) for cm + ciphertext
// `hexToBigint` here normalizes both forms.

import type { Field } from "../crypto/index.js";
import { createHttpClient, type HttpClient, type HttpClientOptions } from "./http.js";

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

/// Server-side FMD-filtered note. Uses `note_id` on the wire; normalized
/// into the same `id` field as `FmdNoteOut` so callers can share mappers.
export interface FmdMatchOut extends FmdNoteOut {}

export interface SubscriptionOut {
    id: number;
    detectionKeyHex: string;
    gamma: number;
    active: boolean;
}

export interface CreateSubscriptionInput {
    detectionKeyHex: string;
    gamma: number;
}

/// Optional query params accepted by most endpoints. `chainId` is added
/// automatically on every URL — callers don't pass it.
type QueryParams = Record<string, string | number | bigint | undefined>;

export class FmdClient {
    private readonly http: HttpClient;

    constructor(
        private readonly baseUrl: string,
        private readonly chainId: bigint,
        opts?: HttpClientOptions | typeof fetch,
    ) {
        // Back-compat: third arg used to be a raw `fetch` impl. Detect and
        // forward into the shared HTTP client, which adds timeout + retry.
        const httpOpts: HttpClientOptions =
            typeof opts === "function" ? { fetchImpl: opts } : (opts ?? {});
        this.http = createHttpClient("FMD_TIMEOUT", "FMD_FAILED", httpOpts);
    }

    health(): Promise<unknown> {
        return this.getJson("/health");
    }

    async fetchPath(cmHex: string): Promise<FmdPath> {
        const data = await this.getJson<{
            leafIndex: number;
            pathElementsHex: string[][];
            pathIndices: number[];
            rootHex: string;
        }>(`/v1/path/${encodeURIComponent(cmHex)}`, { chainId: this.chainId });
        return {
            leafIndex: data.leafIndex,
            pathElements: data.pathElementsHex.map((lvl) => lvl.map((h) => BigInt(h))),
            pathIndices: data.pathIndices,
            root: BigInt(data.rootHex),
        };
    }

    async fetchTreeState(): Promise<FmdTreeState> {
        const data = await this.getJson<{
            leafCount: number;
            rootHex: string;
            frontierHex: string[][];
        }>(`/v1/tree-state`, { chainId: this.chainId });
        return {
            leafCount: data.leafCount,
            root: BigInt(data.rootHex),
            frontier: data.frontierHex.map((lvl) => lvl.map((h) => BigInt(h))),
        };
    }

    listNotes(opts?: { limit?: number; after?: number }): Promise<FmdNoteOut[]> {
        return this.getJson<FmdNoteOut[]>("/v1/notes", {
            chainId: this.chainId,
            limit: opts?.limit,
            after: opts?.after,
        });
    }

    /// Server-side FMD-filtered notes for a registered subscription.
    /// Returned rows use `note_id` on the wire; normalised to `id` so the
    /// shape matches `FmdNoteOut`.
    async listMatches(opts: {
        subscription: number;
        limit?: number;
        after?: number;
    }): Promise<FmdMatchOut[]> {
        const rows = await this.getJson<Array<{ noteId: number } & Omit<FmdMatchOut, "id">>>(
            "/v1/matches",
            {
                subscription: opts.subscription,
                limit: opts.limit,
                after: opts.after,
            },
        );
        return rows.map(({ noteId, ...rest }) => ({ id: noteId, ...rest }));
    }

    /// Batch query the on-chain spent-nullifier set. Returns the subset of
    /// `nfs` that has been consumed on chain. Server enforces a 1024-entry
    /// cap per request.
    async spentSet(nfs: bigint[]): Promise<Set<bigint>> {
        if (nfs.length === 0) return new Set();
        const nullifiers = nfs.map((n) => `0x${n.toString(16).padStart(64, "0")}`);
        const out = await this.postJson<{ spent: string[] }>("/v1/spent", {
            chainId: Number(this.chainId),
            nullifiers,
        });
        return new Set(out.spent.map((h) => BigInt(h)));
    }

    listSubscriptions(): Promise<SubscriptionOut[]> {
        return this.getJson<SubscriptionOut[]>("/v1/subscriptions");
    }

    createSubscription(input: CreateSubscriptionInput): Promise<SubscriptionOut> {
        return this.postJson<SubscriptionOut>("/v1/subscriptions", input);
    }

    async deleteSubscription(id: number): Promise<void> {
        await this.http.fetch(this.url(`/v1/subscriptions/${id}`), { method: "DELETE" });
    }

    /// Build a fully-qualified URL with optional query params. Skips
    /// `undefined` entries so callers can pass conditional pagination
    /// fields without `if`-walls.
    private url(path: string, params?: QueryParams): string {
        if (!params) return this.baseUrl + path;
        const q = new URLSearchParams();
        for (const [k, v] of Object.entries(params)) {
            if (v !== undefined) q.set(k, String(v));
        }
        const qs = q.toString();
        return qs ? `${this.baseUrl}${path}?${qs}` : this.baseUrl + path;
    }

    private async getJson<T>(path: string, params?: QueryParams): Promise<T> {
        const r = await this.http.fetch(this.url(path, params));
        return r.json() as Promise<T>;
    }

    private async postJson<T>(path: string, body: unknown): Promise<T> {
        const r = await this.http.fetch(this.url(path), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });
        return r.json() as Promise<T>;
    }
}
