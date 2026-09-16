// Typed fmd-webserver HTTP client.
//
// The server exposes no per-item lookups: there is no `/v1/path/{cm}` and no
// "is this nullifier spent?" query, because either would tell the server (and
// every proxy log on the way) which note a caller is about to spend. Clients
// page the commitment and nullifier chunk feeds and answer both questions
// locally; see `TreeStore` and `NullifierStore`.
//
// Response shapes live in `./wire.ts` and their validation in `./decode.ts`;
// this module holds the routes and their paging.

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
     * Current sync watermarks. Cheap enough to poll several times a minute:
     * two indexed `MAX()`s, uncached on both sides.
     *
     * Used to gate the expensive reads (`listNotes`, `listMatches` and the
     * chunk feeds) on whether anything changed.
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
        // and `matches` tags rows per chain. Because the detection key is
        // chain-independent, another chain's note would still trial-decrypt
        // here; it would be stored, inflate the balance, and be unspendable,
        // since its leaf index addresses a different tree.
        //
        // The token travels as a header rather than a query param: it is
        // derived from `ivk` and stable across sessions, machines and IPs, so a
        // copy in a URL is a long-lived pseudonymous identifier recorded by
        // every proxy, CDN and access log on the path, on every poll. The
        // chainId is not identifying in that way.
        const raw = await this.json.get<unknown>("/v1/matches", {
            params: { chainId: this.chainId, limit: opts.limit, after: opts.after },
            headers: bearerAuth(opts.token),
        });

        return matchesPage(raw);
    }

    /**
     * Leaves `chunkId * 1024 .. +1024`. Complete chunks are immutable.
     *
     * One of the two routes exempted from the SDK's blanket `no-store`. The
     * feed is global and append-only: every wallet fetches the identical
     * bytes, so a cache entry reveals only that this device synced, which the
     * request already reveals. The origin serves complete chunks as
     * `max-age=31536000, immutable`; honoring that lets a repeat sync skip the
     * network for this feed, the largest transfer in a cold sync.
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
                // Cacheable for the same reason as the commitment feed: the set
                // is global and the client downloads all of it, so the server
                // learns nothing.
                { cache: "default", ...(opts.signal ? { signal: opts.signal } : {}) },
            ),
        );
    }

    /**
     * Idempotent under a stable `tokenHex`: a repeat with the same detection
     * key and γ re-attaches to the existing subscription (`created: false`).
     * A repeat with a *different* detection key is rejected 409 rather than
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
