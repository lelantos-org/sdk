// Typed fmd-webserver HTTP client.
//
// Backend hex format inconsistency note:
//   /v1/path     and /v1/tree-state return 0x-prefixed hex
//   /v1/notes    returns BARE hex (no 0x) for cm + ciphertext
// `hexToBigint` here normalizes both forms.

import type { Field } from "../crypto/index";

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

export class FmdClient {
    private readonly fetchImpl: typeof fetch;

    constructor(
        private readonly baseUrl: string,
        private readonly chainId: bigint,
        fetchImpl?: typeof fetch,
    ) {
        // Detached `fetch` references throw "Illegal invocation" in browsers
        // because the global `fetch` requires `this === window`. Wrap the
        // default and bind any custom impl to keep the binding stable.
        this.fetchImpl = fetchImpl ?? ((...args) => fetch(...args));
    }

    async health(): Promise<unknown> {
        return this.getJson("/health");
    }

    async fetchPath(cmHex: string): Promise<FmdPath> {
        const data = await this.getJson<{
            leafIndex: number;
            pathElementsHex: string[][];
            pathIndices: number[];
            rootHex: string;
        }>(`/v1/path/${encodeURIComponent(cmHex)}?${this.chainQuery()}`);
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
        }>(`/v1/tree-state?${this.chainQuery()}`);
        return {
            leafCount: data.leafCount,
            root: BigInt(data.rootHex),
            frontier: data.frontierHex.map((lvl) => lvl.map((h) => BigInt(h))),
        };
    }

    async listNotes(opts?: { limit?: number; after?: number }): Promise<FmdNoteOut[]> {
        const q = new URLSearchParams();
        q.set("chainId", this.chainId.toString());
        if (opts?.limit != null) q.set("limit", String(opts.limit));
        if (opts?.after != null) q.set("after", String(opts.after));
        return this.getJson<FmdNoteOut[]>(`/v1/notes?${q.toString()}`);
    }

    /// Server-side FMD-filtered notes for a registered subscription.
    /// Returned rows use `note_id` on the wire; normalized to `id` so the
    /// shape matches `FmdNoteOut`.
    async listMatches(opts: {
        subscription: number;
        limit?: number;
        after?: number;
    }): Promise<FmdMatchOut[]> {
        const q = new URLSearchParams();
        q.set("subscription", String(opts.subscription));
        if (opts.limit != null) q.set("limit", String(opts.limit));
        if (opts.after != null) q.set("after", String(opts.after));
        const rows = await this.getJson<Array<{ noteId: number } & Omit<FmdMatchOut, "id">>>(
            `/v1/matches?${q.toString()}`,
        );
        return rows.map(({ noteId, ...rest }) => ({ id: noteId, ...rest }));
    }

    /// Batch query the on-chain spent-nullifier set. Returns the subset of
    /// `nfs` that has been consumed on chain (subset, not parallel mask).
    /// Server enforces a 1024-entry cap per request.
    async spentSet(nfs: bigint[]): Promise<Set<bigint>> {
        if (nfs.length === 0) return new Set();
        const nullifiers = nfs.map(
            (n) => "0x" + n.toString(16).padStart(64, "0"),
        );
        const out = await this.postJson<{ spent: string[] }>(`/v1/spent`, {
            chainId: Number(this.chainId),
            nullifiers,
        });
        return new Set(out.spent.map((h) => BigInt(h)));
    }

    async listSubscriptions(): Promise<SubscriptionOut[]> {
        return this.getJson<SubscriptionOut[]>(`/v1/subscriptions`);
    }

    async createSubscription(input: CreateSubscriptionInput): Promise<SubscriptionOut> {
        return this.postJson<SubscriptionOut>(`/v1/subscriptions`, input);
    }

    async deleteSubscription(id: number): Promise<void> {
        const r = await this.fetchImpl(`${this.baseUrl}/v1/subscriptions/${id}`, {
            method: "DELETE",
        });
        if (!r.ok) {
            throw new Error(`fmd DELETE /v1/subscriptions/${id} -> ${r.status}: ${await r.text()}`);
        }
    }

    private chainQuery(): string {
        const q = new URLSearchParams();
        q.set("chainId", this.chainId.toString());
        return q.toString();
    }

    private async getJson<T>(path: string): Promise<T> {
        const r = await this.fetchImpl(this.baseUrl + path);
        if (!r.ok) {
            throw new Error(`fmd GET ${path} -> ${r.status}: ${await r.text()}`);
        }
        return r.json() as Promise<T>;
    }

    private async postJson<T>(path: string, body: unknown): Promise<T> {
        const r = await this.fetchImpl(this.baseUrl + path, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });
        if (!r.ok) {
            throw new Error(`fmd POST ${path} -> ${r.status}: ${await r.text()}`);
        }
        return r.json() as Promise<T>;
    }
}
