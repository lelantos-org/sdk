// Typed fmd-webserver HTTP client.
//
// The server deliberately exposes no per-item lookups: there is no
// `/v1/path/{cm}` and no "is this nullifier spent?" query, because either one
// would tell the server (and every proxy log on the way) exactly which note a
// caller is about to spend. Clients page the commitment and nullifier chunk
// feeds instead and answer both questions locally — see `TreeStore` and
// `NullifierStore`.
//
// Wire encoding stops here. Every response is validated through `core/decode`
// and returned as domain values (`Field`, `Point`, `Uint8Array`), so a
// malformed response raises a `WireFormatError` naming the offending JSON path
// instead of a `TypeError` surfacing later inside a store.
//
// That validation is not cosmetic. The backend is inconsistent about the `0x`
// prefix — tree state, nullifiers, clue bits and curve coordinates carry it;
// note/match commitments and ciphertexts and chunk commitments do not. Every
// one of them is hex, so every one goes through `hexInt`/`hexBytes` and none
// through `bigintFrom`: that decoder also accepts decimal, and a bare-hex
// value whose digits happen to all be decimal would decode as the wrong
// number, silently.

import { bool, hexBytes, hexInt, int, mapArr, obj } from "../../core/decode.js";
import {
    bearerAuth,
    createJsonClient,
    type HttpClientOptions,
    type JsonClient,
} from "../../core/http.js";
import type { Field, Point } from "../../crypto/index.js";
import { assertDetectionGamma } from "../../fmd/fmd.js";

export interface FmdTreeState {
    chainId: number;
    leafCount: number;
    root: Field;
    frontier: Field[][];
}

export interface FmdNoteOut {
    id: number;
    chainId: number;
    blockNumber: number;
    leafIndex: number;
    cm: Field;
    /** First 2 ciphertext bytes as a big-endian u16. FMD bucket tag. */
    clueBits: number;
    ciphertext: Uint8Array;
    /** Sender's ECDH ephemeral public point; feeds `decryptNote`. */
    ephPub: Point;
}

/** Server-side FMD-filtered note. Wire field `noteId` normalised to `id`. */
export interface FmdMatchOut extends FmdNoteOut {}

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
    cm: Field;
    /** Value-commitment point; hashed together with `cm` into the Merkle leaf. */
    cvDep: Point;
}

export interface CommitmentChunkOut {
    chunkId: number;
    entries: CommitmentChunkEntry[];
    /** `false` marks the tail chunk — the client stops paging here. */
    isComplete: boolean;
}

export interface NullifierChunkOut {
    chunkId: number;
    /** Ascending by insertion order. */
    nullifiers: Field[];
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

/** Curve points arrive as sibling hex fields, `<prefix>X` and `<prefix>Y`. */
function point(d: Record<string, unknown>, prefix: string, path: string): Point {
    return [
        hexInt(d[`${prefix}X`], `${path}.${prefix}X`),
        hexInt(d[`${prefix}Y`], `${path}.${prefix}Y`),
    ];
}

/** Shared by `/v1/notes` and `/v1/matches`, which differ only in the id field. */
function note(raw: unknown, idField: "id" | "noteId", path: string): FmdNoteOut {
    const d = obj(raw, path);
    return {
        id: int(d[idField], `${path}.${idField}`),
        chainId: int(d.chainId, `${path}.chainId`),
        blockNumber: int(d.blockNumber, `${path}.blockNumber`),
        leafIndex: int(d.leafIndex, `${path}.leafIndex`),
        cm: hexInt(d.commitmentHex, `${path}.commitmentHex`),
        // A u16 bucket tag, so it always fits a JS number.
        clueBits: Number(hexInt(d.clueBitsHex, `${path}.clueBitsHex`)),
        ciphertext: hexBytes(d.ciphertextHex, `${path}.ciphertextHex`),
        ephPub: point(d, "ephPub", path),
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
                cm: hexInt(entry.cmHex, `${p}.cmHex`),
                cvDep: point(entry, "cvDep", p),
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
    }): Promise<FmdMatchOut[]> {
        // The token is the whole authorisation, so nothing else — not even
        // chainId — rides along; the subscription already pins the chain.
        //
        // It travels as a header rather than a query param: derived from `ivk`
        // and stable across sessions, machines and IPs, a copy in a URL is a
        // long-lived pseudonymous identifier recorded by every proxy, CDN and
        // access log on the path, on every poll.
        const raw = await this.json.get<unknown>("/v1/matches", {
            params: { limit: opts.limit, after: opts.after },
            headers: bearerAuth(opts.token),
        });
        return mapArr(raw, "$", (row, p) => note(row, "noteId", p));
    }

    /** Leaves `chunkId * 1024 .. +1024`. Complete chunks are immutable. */
    async fetchCommitmentChunk(chunkId: number): Promise<CommitmentChunkOut> {
        return commitmentChunk(
            await this.json.get<unknown>(
                `/v1/chains/${this.chainId}/commitments/chunks/${chunkId}`,
            ),
        );
    }

    /**
     * Spent nullifiers `chunkId * 1024 .. +1024` in insertion order. The whole
     * set is paged down and filtered client-side — the server must never learn
     * which nullifiers a wallet cares about.
     */
    async fetchNullifierChunk(chunkId: number): Promise<NullifierChunkOut> {
        return nullifierChunk(
            await this.json.get<unknown>(`/v1/chains/${this.chainId}/nullifiers/chunks/${chunkId}`),
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
