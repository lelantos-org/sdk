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

export class FmdClient {
    constructor(
        private readonly baseUrl: string,
        private readonly chainId: bigint,
        private readonly fetchImpl: typeof fetch = fetch,
    ) {}

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
}
