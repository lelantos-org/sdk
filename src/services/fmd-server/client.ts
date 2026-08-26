// Typed fmd-webserver HTTP client.
//
// The server exposes no per-item lookups: there is no
// `/v1/path/{cm}` and no "is this nullifier spent?" query, because either one
// would tell the server (and every proxy log on the way) exactly which note a
// caller is about to spend. Clients page the commitment and nullifier chunk
// feeds instead and answer both questions locally — see `TreeStore` and
// `NullifierStore`.
//
// Wire encoding stops here. Every response is validated through `core/decode`
// and returned as domain values (`Field`, `Uint8Array`), so a malformed
// response raises a `WireFormatError` naming the offending JSON path instead
// of a `TypeError` surfacing later inside a store.
//
// That validation is not cosmetic. The backend is inconsistent about the `0x`
// prefix — tree state, nullifiers and chunk leaf hashes carry it; note/match
// commitments, ciphertexts and packed points do not. Every one of them is hex,
// so every one goes through `hexInt`/`hexBytes` and none through `bigintFrom`:
// that decoder also accepts decimal, and a bare-hex value whose digits happen
// to all be decimal would decode as the wrong number, silently.

import { bool, hexBytes, hexBytesN, hexInt, int, mapArr, obj } from "../../core/decode.js";
import { bearerAuth, type HttpClientOptions } from "../../core/http.js";
import { createJsonClient, type JsonClient } from "../../core/json-client.js";
import type { Field } from "../../crypto/index.js";
import { assertDetectionGamma } from "../../fmd/fmd.js";

export interface FmdTreeState {
    chainId: number;
    leafCount: number;
    root: Field;
    frontier: Field[][];
}

/**
 * The two watermarks a wallet syncs against.
 *
 * Polled far more often than anything else, so it carries only what a client
 * needs to decide whether the expensive reads are worth making.
 */
export interface FmdHead {
    chainId: number;
    maxNoteId: number;
    maxNullifierSeq: number;
}

export interface FmdNoteOut {
    id: number;
    chainId: number;
    blockNumber: number;
    leafIndex: number;
    cm: Field;
    ciphertext: Uint8Array;
    /**
     * Sender's ECDH ephemeral public point, already packed by the server the
     * way `babyJub.packPoint` packs one: 32 bytes of `y` little-endian with
     * the high bit of the last byte carrying `sign(x)`.
     *
     * Bytes, not a `Point`: this is exactly what `decryptNote` wants as `epk`,
     * so nothing on this path ever unpacks it.
     */
    epk: Uint8Array;
}

/** Server-side FMD-filtered note. Wire field `noteId` normalised to `id`. */
export interface FmdMatchOut extends FmdNoteOut {}

/**
 * A page of matches plus the subscription's backfill watermark.
 *
 * `matches` is filled from both ends at once: the indexer's live tick inserts
 * rows for notes at the head while its backfill walks history upward. So the
 * highest `id` in a page is NOT a safe resume cursor — rows below it may still
 * be pending, and a cursor placed above the gap would skip them permanently.
 *
 * `backfilledThroughNoteId` is the highest note id already scanned against
 * this subscription's key; a persisted cursor must be clamped to it. Rows
 * above it are still delivered, so a new note never waits for a backfill —
 * they are simply re-delivered until the watermark passes them, which
 * `addHits` dedupes by `cm`.
 */
export interface FmdMatchesPage {
    matches: FmdMatchOut[];
    backfilledThroughNoteId: number;
}

/**
 * Result of `POST /v1/subscriptions`. Neither the token nor the detection key
 * is echoed: the caller derives and supplies both.
 *
 * `created` is `false` when the token already had a subscription behind it
 * and this call re-attached to it, as when a wallet re-derives after losing
 * local state. That subscription's backfill is already under way or complete,
 * so matches may be available immediately.
 */
export interface SubscriptionOut {
    gamma: number;
    active: boolean;
    created: boolean;
}

export interface CommitmentChunkEntry {
    leafIndex: number;
    /**
     * `Poseidon(TAG_LEAF, cm, cvDep.x, cvDep.y)`, computed server-side.
     *
     * Sending the hash rather than `cm` and the `cvDep` point is one field
     * element instead of three: it avoids ~1.05M pure-JS Poseidon-4 calls over
     * a full tree, the largest single term in a cold sync, and cuts this feed
     * roughly threefold on the wire.
     *
     * The client does not derive leaves from primary data, so a wrong value
     * here yields a wrong root — a rejected transaction, not a loss of funds.
     * `TreeStore.verifyRoot` catches it.
     */
    leafHash: Field;
}

export interface CommitmentChunkOut {
    chunkId: number;
    entries: CommitmentChunkEntry[];
    /** `false` marks the tail chunk — the client stops paging here. */
    isComplete: boolean;
}

export interface NullifierChunkOut {
    chunkId: number;
    /**
     * Ascending by insertion order.
     *
     * `bigint`, not `Field`: the server sends the low 10 bytes of each
     * nullifier, so these are truncations rather than field elements and must
     * not be fed anywhere a real nullifier is expected. Compare against one
     * only through `NullifierStore.has`, which truncates its argument the same
     * way.
     */
    nullifiers: bigint[];
    isComplete: boolean;
}

/**
 * γ sets the false-positive rate at `2^-γ`. Server-enforced range; it
 * additionally caps γ against the current note count so a match set always
 * keeps enough decoys, and rejects a `detectionKeyHex` that is not exactly
 * `gamma * 32` bytes.
 */
export const GAMMA_MIN = 1;
// Mirrors the server's declared range. Two lower limits bind first:
// `AuxValidation.sol` masks the on-chain clue-bits field to 0x3FFF, so bits
// 14-15 are never set, and senders pack only `FMD_SENDER_GAMMA` bits. The
// effective limit is `assertDetectionGamma`.
export const GAMMA_MAX = 16;

export interface CreateSubscriptionInput {
    /**
     * The γ expanded detection scalars, from `detectionKeyFor` +
     * `detectionKeyToHex`.
     *
     * Confers the full detection capability, which cannot be scoped or
     * revoked: `h_i` is public, so `dk = x_i - h_i` recovers the root. The
     * server can then identify this recipient's incoming notes, at a 2^-γ
     * false-positive rate, for as long as the key is valid.
     */
    detectionKeyHex: string;
    gamma: number;
    /**
     * Capability token for `/v1/matches` and `DELETE /v1/subscriptions`,
     * bare 32-byte hex. Build it with `deriveSubscriptionToken` +
     * `subscriptionTokenToHex`, never from `dk` or the detection key: the
     * scalars are `x_i = dk + h_i` over a publicly computable `h_i`, so this
     * server can invert either back to `dk` and mint its own token.
     */
    tokenHex: string;
}

// ─── decoders ────────────────────────────────────────────────────────────────

/** Bytes in a packed Baby-Jubjub point: `y` plus one sign bit. */
const PACKED_POINT_BYTES = 32;

/** Shared by `/v1/notes` and `/v1/matches`, which differ only in the id field. */
function note(raw: unknown, idField: "id" | "noteId", path: string): FmdNoteOut {
    const d = obj(raw, path);
    return {
        id: int(d[idField], `${path}.${idField}`),
        chainId: int(d.chainId, `${path}.chainId`),
        blockNumber: int(d.blockNumber, `${path}.blockNumber`),
        leafIndex: int(d.leafIndex, `${path}.leafIndex`),
        cm: hexInt(d.commitmentHex, `${path}.commitmentHex`),
        ciphertext: hexBytes(d.ciphertextHex, `${path}.ciphertextHex`),
        // Width-checked here because `epk` reaches `decryptNote` untouched: a
        // short or over-long value would otherwise surface as a decryption
        // failure with nothing pointing back at the response that caused it.
        epk: hexBytesN(d.ephPubPackedHex, `${path}.ephPubPackedHex`, PACKED_POINT_BYTES),
    };
}

function head(raw: unknown): FmdHead {
    const d = obj(raw, "$");
    return {
        chainId: int(d.chainId, "$.chainId"),
        maxNoteId: int(d.maxNoteId, "$.maxNoteId"),
        maxNullifierSeq: int(d.maxNullifierSeq, "$.maxNullifierSeq"),
    };
}

function treeState(raw: unknown): FmdTreeState {
    const d = obj(raw, "$");
    return {
        chainId: int(d.chainId, "$.chainId"),
        leafCount: int(d.leafCount, "$.leafCount"),
        root: hexInt(d.rootHex, "$.rootHex"),
        frontier: mapArr(d.frontierHex, "$.frontierHex", (lvl, p) => mapArr(lvl, p, hexInt)),
    };
}

function commitmentChunk(raw: unknown): CommitmentChunkOut {
    const d = obj(raw, "$");
    return {
        chunkId: int(d.chunkId, "$.chunkId"),
        entries: mapArr(d.entries, "$.entries", (e, p) => {
            const entry = obj(e, p);
            return {
                leafIndex: int(entry.leafIndex, `${p}.leafIndex`),
                leafHash: hexInt(entry.leafHash, `${p}.leafHash`),
            };
        }),
        isComplete: bool(d.isComplete, "$.isComplete"),
    };
}

function nullifierChunk(raw: unknown): NullifierChunkOut {
    const d = obj(raw, "$");
    return {
        chunkId: int(d.chunkId, "$.chunkId"),
        nullifiers: mapArr(d.nullifiers, "$.nullifiers", hexInt),
        isComplete: bool(d.isComplete, "$.isComplete"),
    };
}

function subscription(raw: unknown): SubscriptionOut {
    const d = obj(raw, "$");
    return {
        gamma: int(d.gamma, "$.gamma"),
        active: bool(d.active, "$.active"),
        created: bool(d.created, "$.created"),
    };
}

// ─── client ──────────────────────────────────────────────────────────────────

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
     * The point is to gate the expensive reads — `listNotes`, `listMatches`
     * and the chunk feeds — on whether anything actually moved.
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
        return mapArr(raw, "$", (row, p) => note(row, "id", p));
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
        // `chainId` is required, and the earlier claim that "the subscription
        // already pins the chain" was wrong: `subscriptions.detection_key` is
        // globally unique, so one subscription spans every chain a deployment
        // serves, and `matches` tags rows per chain. Because the detection key
        // is chain-independent, another chain's note still trial-decrypts here
        // — it would be stored, inflate the balance, and be unspendable, since
        // its leaf index addresses a different tree.
        //
        // The token still travels as a header rather than a query param:
        // derived from `ivk` and stable across sessions, machines and IPs, a
        // copy in a URL is a long-lived pseudonymous identifier recorded by
        // every proxy, CDN and access log on the path, on every poll. The
        // chainId is not identifying in that way.
        const raw = await this.json.get<unknown>("/v1/matches", {
            params: { chainId: this.chainId, limit: opts.limit, after: opts.after },
            headers: bearerAuth(opts.token),
        });

        // A server predating the watermark answers with a bare array. Treat
        // its watermark as 0 — "nothing is known to be backfilled" — which
        // pins the caller's persisted cursor at 0 and degrades to re-scanning
        // from the start rather than silently skipping notes.
        if (Array.isArray(raw)) {
            return {
                matches: mapArr(raw, "$", (row, p) => note(row, "noteId", p)),
                backfilledThroughNoteId: 0,
            };
        }

        const d = obj(raw, "$");
        return {
            matches: mapArr(d.matches, "$.matches", (row, p) => note(row, "noteId", p)),
            backfilledThroughNoteId: int(d.backfilledThroughNoteId, "$.backfilledThroughNoteId"),
        };
    }

    /**
     * Leaves `chunkId * 1024 .. +1024`. Complete chunks are immutable.
     *
     * One of the two routes exempted from the SDK's blanket `no-store`. The
     * feed is global and append-only: every wallet fetches the identical
     * bytes, so a cache entry says only that this device synced, which the
     * request itself already said. The origin serves complete chunks as
     * `max-age=31536000, immutable`, and honoring that turns a repeat sync
     * into no network at all — the single largest transfer in a cold sync.
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
     * set is paged down and filtered client-side — the server must never learn
     * which nullifiers a wallet cares about.
     */
    async fetchNullifierChunk(
        chunkId: number,
        opts: { signal?: AbortSignal | undefined } = {},
    ): Promise<NullifierChunkOut> {
        return nullifierChunk(
            await this.json.get<unknown>(
                `/v1/chains/${this.chainId}/nullifiers/chunks/${chunkId}`,
                // Cacheable for the same reason as the commitment feed: the
                // whole set is global, and it is precisely because the client
                // downloads all of it that the server learns nothing.
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

    /** Token travels in the `Authorization` header, not the path — see `listMatches`. */
    async deleteSubscription(token: string): Promise<void> {
        await this.json.del("/v1/subscriptions", { headers: bearerAuth(token) });
    }
}
