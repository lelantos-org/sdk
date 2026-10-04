// Typed fmd-webserver HTTP client: the routes. Response shapes are in
// `./wire.ts`, their validation in `./decode.ts`.
//
// The server exposes no per-item lookups (Merkle path by commitment, nullifier
// spent-check): either would tell the server, and every proxy log on the way,
// which note a caller is about to spend. Clients page the commitment and
// nullifier chunk feeds and answer both locally; see `TreeStore` and
// `NullifierStore`.

import { assertDetectionGamma } from "../../fmd/keys.js";
import { bearerAuth, type HttpClientOptions } from "../http/client.js";
import { createJsonClient, type JsonClient } from "../http/json-client.js";
import {
    commitmentChunk,
    head,
    matchesPage,
    notesPage,
    nullifierChunk,
    subscription,
    treeState,
} from "./decode.js";
import type {
    CommitmentChunkOut,
    CreateSubscriptionInput,
    FmdHead,
    FmdMatchesPage,
    FmdNoteOut,
    FmdTreeState,
    NullifierChunkOut,
    SubscriptionOut,
} from "./wire.js";

export class FmdClient {
    private readonly json: JsonClient;
    /** Pre-stringified: a path segment on the chunk feeds, a query param elsewhere. */
    private readonly chainId: string;

    constructor(baseUrl: string, chainId: bigint, opts: HttpClientOptions = {}) {
        this.chainId = String(chainId);
        this.json = createJsonClient(
            baseUrl,
            { timeout: "FMD_TIMEOUT", failure: "FMD_FAILED" },
            opts,
        );
    }

    /**
     * Current sync watermarks, cheap enough to poll. Gates the expensive reads
     * (`listNotes`, `listMatches` and the chunk feeds) on whether anything
     * changed.
     */
    async fetchHead(): Promise<FmdHead> {
        return head(
            await this.json.get<unknown>("/v1/head", { params: { chainId: this.chainId } }),
        );
    }

    async fetchTreeState(): Promise<FmdTreeState> {
        return treeState(
            await this.json.get<unknown>("/v1/tree-state", { params: { chainId: this.chainId } }),
        );
    }

    async listNotes(opts?: { limit?: number; after?: number }): Promise<FmdNoteOut[]> {
        const raw = await this.json.get<unknown>("/v1/notes", {
            params: { chainId: this.chainId, limit: opts?.limit, after: opts?.after },
        });
        return notesPage(raw);
    }

    /**
     * Server-side FMD-filtered notes for a subscription, addressed by the
     * capability token from `createSubscription`.
     */
    async listMatches(opts: {
        token: string;
        limit?: number;
        after?: number;
    }): Promise<FmdMatchesPage> {
        // `chainId` is required: `subscriptions.detection_key` is globally
        // unique, so one subscription spans every chain a deployment serves,
        // and `matches` tags rows per chain. The detection key is
        // chain-independent, so another chain's note would trial-decrypt
        // here, be stored, inflate the balance and be unspendable: its leaf
        // index addresses a different tree.
        //
        // The token travels as a header, not a query param: it is derived
        // from `ivk` and stable across sessions, machines and IPs, so in a URL
        // it is a long-lived pseudonymous identifier recorded by every proxy,
        // CDN and access log on the path, on every poll.
        const raw = await this.json.get<unknown>("/v1/matches", {
            params: { chainId: this.chainId, limit: opts.limit, after: opts.after },
            headers: bearerAuth(opts.token),
        });

        return matchesPage(raw);
    }

    /**
     * Leaves `chunkId * 1024 .. +1024`. Complete chunks are immutable.
     *
     * Exempt from the SDK's default `no-store`. The feed is global and
     * append-only: every wallet fetches identical bytes, so a cache entry
     * reveals only that this device synced, which the request already
     * reveals. The origin serves complete chunks as
     * `max-age=31536000, immutable`, so a repeat sync can skip the network.
     */
    async fetchCommitmentChunk(
        chunkId: number,
        opts: { signal?: AbortSignal | undefined } = {},
    ): Promise<CommitmentChunkOut> {
        return commitmentChunk(
            await this.json.get<unknown>(
                `/v1/chains/${this.chainId}/commitments/chunks/${chunkId}`,
                { cache: "default", ...(opts.signal ? { signal: opts.signal } : {}) },
            ),
        );
    }

    /**
     * Spent nullifiers `chunkId * 1024 .. +1024` in insertion order. The whole
     * set is paged down and filtered client-side so the server never learns
     * which nullifiers a wallet cares about.
     */
    async fetchNullifierChunk(
        chunkId: number,
        opts: { signal?: AbortSignal | undefined } = {},
    ): Promise<NullifierChunkOut> {
        return nullifierChunk(
            await this.json.get<unknown>(
                `/v1/chains/${this.chainId}/nullifiers/chunks/${chunkId}`,
                // Cacheable for the same reason as the commitment feed.
                { cache: "default", ...(opts.signal ? { signal: opts.signal } : {}) },
            ),
        );
    }

    /**
     * Idempotent under a stable `tokenHex`: a repeat with the same detection
     * key and γ re-attaches to the existing subscription (`created: false`).
     * A repeat with a different detection key is rejected 409 rather than
     * repointing the row, which would hand this caller the match stream of
     * whoever registered the token first.
     */
    async createSubscription(input: CreateSubscriptionInput): Promise<SubscriptionOut> {
        // Also guarded in `detectionKeyFor`; enforced here so a hand-built
        // subscription cannot register a γ senders never emit.
        assertDetectionGamma(input.gamma);
        return subscription(await this.json.post<unknown>("/v1/subscriptions", input));
    }

    /** Token travels in the `Authorization` header, not the path; see `listMatches`. */
    async deleteSubscription(token: string): Promise<void> {
        await this.json.del("/v1/subscriptions", { headers: bearerAuth(token) });
    }
}
