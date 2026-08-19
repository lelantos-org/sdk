import { afterEach, describe, expect, it, vi } from "vitest";
import { hexToBytes } from "../../core/hex.js";
import { FMD_SENDER_GAMMA } from "../../fmd/fmd.js";
import { FmdClient } from "./client.js";

// The client is the only place fmd-webserver's wire encoding is understood, so
// these pin the decode boundary: domain values out, `WireFormatError` with a
// JSON path in, and — most of all — bare hex read as hex.

const BASE = "https://fmd.test";
const CHAIN = 31337n;

function respondWith(body: unknown): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
}

function client(): FmdClient {
    return new FmdClient(BASE, CHAIN);
}

afterEach(() => vi.unstubAllGlobals());

/** A 32-byte bare-hex commitment made only of decimal digits. */
const DIGITS_ONLY_CM = "1234".padStart(64, "0");

/**
 * `babyJub.packPoint(Base8)`. Shares its value with the Rust test
 * `services::field::tests::packs_a_point_as_little_endian_y`, which is what
 * pins the two implementations to the same byte order.
 */
const PACKED_BASE8 = "8b7d2d877a253c4b7733e1b91f05e0fcedf96bd11c2e572549b2a0f703727925";

const NOTE_ROW = {
    id: 7,
    chainId: 31337,
    blockNumber: 100,
    leafIndex: 3,
    commitmentHex: DIGITS_ONLY_CM,
    ciphertextHex: "dead",
    // Packed Base8: 32 bytes of `y` little-endian, sign bit of `x` clear.
    ephPubPackedHex: PACKED_BASE8,
};

describe("listNotes", () => {
    it("decodes wire strings into domain values", async () => {
        respondWith([NOTE_ROW]);

        const [n] = await client().listNotes();
        if (!n) throw new Error("expected one note");

        expect(n.id).toBe(7);
        expect(n.ciphertext).toEqual(new Uint8Array([0xde, 0xad]));
        // Byte-for-byte, in order: `epk` goes straight to `decryptNote`, and
        // decoding it as a big-endian integer would silently reverse it — the
        // packed form is little-endian `y` with the sign bit in the last byte.
        expect(n.epk).toEqual(hexToBytes(PACKED_BASE8));
    });

    it("reads a bare-hex commitment as hex even when it is all digits", async () => {
        respondWith([NOTE_ROW]);

        const [n] = await client().listNotes();
        if (!n) throw new Error("expected one note");

        // The trap: `commitmentHex` has no `0x`, and this value parses as a
        // decimal string too. Decoding it as decimal yields 1234n.
        expect(n.cm).toBe(BigInt(`0x${DIGITS_ONLY_CM}`));
        expect(n.cm).not.toBe(1234n);
    });

    it("names the offending field when the server sends a bad row", async () => {
        respondWith([{ ...NOTE_ROW, ephPubPackedHex: "not-hex" }]);

        await expect(client().listNotes()).rejects.toMatchObject({
            path: "$[0].ephPubPackedHex",
        });
    });

    it("rejects a packed point that is not 32 bytes", async () => {
        // Well-formed hex, wrong width. `epk` goes straight to `decryptNote`,
        // so an unchecked short value fails far from its cause.
        respondWith([{ ...NOTE_ROW, ephPubPackedHex: "8b7d" }]);

        await expect(client().listNotes()).rejects.toMatchObject({
            path: "$[0].ephPubPackedHex",
        });
    });

    it("sends chainId as a query param", async () => {
        const fetchMock = respondWith([]);

        await client().listNotes({ limit: 5, after: 2 });

        const url = new URL(fetchMock.mock.calls[0]![0] as string);
        expect(url.pathname).toBe("/v1/notes");
        expect(url.searchParams.get("chainId")).toBe("31337");
        expect(url.searchParams.get("limit")).toBe("5");
    });
});

describe("listMatches", () => {
    it("normalises `noteId` to `id` and authorises with the token alone", async () => {
        const { id: _id, ...rest } = NOTE_ROW;
        const fetchMock = respondWith({
            backfilledThroughNoteId: 40,
            matches: [{ ...rest, noteId: 42 }],
        });

        const { matches } = await client().listMatches({ token: "abcd" });
        const [m] = matches;
        if (!m) throw new Error("expected one match");

        expect(m.id).toBe(42);
        const [target, init] = fetchMock.mock.calls[0]!;
        const url = new URL(target as string);
        // The token is a stable pseudonymous identifier sent on every poll. In
        // a URL it is copied into every proxy and access log on the path, so it
        // must travel in a header and nowhere else.
        expect(url.search).not.toContain("abcd");
        expect(url.searchParams.has("token")).toBe(false);
        expect((init as RequestInit).headers).toMatchObject({
            Authorization: "Bearer abcd",
        });
        // The subscription does NOT pin the chain: `detection_key` is globally
        // unique, so one subscription spans every chain a deployment serves.
        // Without this the feed returns other chains' notes, which decrypt
        // against the same chain-independent key and land in the wallet as
        // unspendable balance.
        expect(url.searchParams.get("chainId")).toBe(String(CHAIN));
    });

    it("reads the backfill watermark from the envelope", async () => {
        respondWith({ backfilledThroughNoteId: 1234, matches: [] });

        const page = await client().listMatches({ token: "abcd" });

        expect(page.backfilledThroughNoteId).toBe(1234);
        expect(page.matches).toEqual([]);
    });

    it("treats a bare array from an older server as watermark 0", async () => {
        // Nothing is known to be backfilled, so a caller clamping its cursor
        // to this re-scans rather than stepping over rows still pending.
        const { id: _id, ...rest } = NOTE_ROW;
        respondWith([{ ...rest, noteId: 42 }]);

        const page = await client().listMatches({ token: "abcd" });

        expect(page.matches).toHaveLength(1);
        expect(page.backfilledThroughNoteId).toBe(0);
    });
});

describe("deleteSubscription", () => {
    it("puts the token in a header, not the path", async () => {
        const fetchMock = respondWith({});

        await client().deleteSubscription("abcd");

        const [target, init] = fetchMock.mock.calls[0]!;
        expect(new URL(target as string).pathname).toBe("/v1/subscriptions");
        expect((init as RequestInit).headers).toMatchObject({
            Authorization: "Bearer abcd",
        });
    });
});

describe("chunk feeds", () => {
    it("decodes commitment entries into a pre-hashed leaf", async () => {
        respondWith({
            chunkId: 0,
            entries: [{ leafIndex: 0, leafHash: "0x0a" }],
            isComplete: false,
        });

        const chunk = await client().fetchCommitmentChunk(0);

        // The leaf arrives ready to insert; `cm`/`cvDep` are no longer served,
        // so nothing here recomputes it.
        expect(chunk.entries[0]).toEqual({ leafIndex: 0, leafHash: 10n });
        expect(chunk.isComplete).toBe(false);
    });

    it("reads the leaf hash as hex, not decimal", async () => {
        // The `0x` prefix is what disambiguates: these digits are also a valid
        // decimal literal for a different number.
        respondWith({
            chunkId: 0,
            entries: [{ leafIndex: 0, leafHash: `0x${"12345678".padStart(64, "0")}` }],
            isComplete: false,
        });

        const chunk = await client().fetchCommitmentChunk(0);

        expect(chunk.entries[0]?.leafHash).toBe(0x12345678n);
        expect(chunk.entries[0]?.leafHash).not.toBe(12345678n);
    });

    it("rejects a commitment entry with no leaf hash", async () => {
        // A server that predates the pre-hashed feed must fail loudly rather
        // than yield a tree of undefined leaves.
        respondWith({
            chunkId: 0,
            entries: [{ leafIndex: 0, cmHex: "0a", cvDepX: "0x01", cvDepY: "0x02" }],
            isComplete: false,
        });

        await expect(client().fetchCommitmentChunk(0)).rejects.toThrow(/leafHash/);
    });

    it("decodes nullifiers to Fields and puts chainId in the path", async () => {
        const fetchMock = respondWith({
            chunkId: 2,
            nullifiers: ["0x0a", "0x0b"],
            isComplete: true,
        });

        const chunk = await client().fetchNullifierChunk(2);

        expect(chunk.nullifiers).toEqual([10n, 11n]);
        const url = new URL(fetchMock.mock.calls[0]![0] as string);
        expect(url.pathname).toBe("/v1/chains/31337/nullifiers/chunks/2");
    });

    it("rejects a non-boolean isComplete rather than coercing it", async () => {
        // `isComplete` decides whether paging stops; a truthy string would
        // read as "keep going" and a `0` as "stop" if it were coerced.
        respondWith({ chunkId: 0, nullifiers: [], isComplete: "true" });

        await expect(client().fetchNullifierChunk(0)).rejects.toMatchObject({
            path: "$.isComplete",
        });
    });
});

describe("createSubscription", () => {
    it("decodes the re-attach signal", async () => {
        respondWith({ gamma: FMD_SENDER_GAMMA, active: true, created: false });

        await expect(
            client().createSubscription({
                detectionKeyHex: "ab",
                gamma: FMD_SENDER_GAMMA,
                tokenHex: "cd",
            }),
        ).resolves.toEqual({ gamma: FMD_SENDER_GAMMA, active: true, created: false });
    });

    it("rejects a gamma above the sender gamma before it reaches the wire", async () => {
        // Senders zero-pad clue bits past FMD_SENDER_GAMMA, so a longer
        // detection key discards the caller's own notes.
        const fetchMock = respondWith({ gamma: 8, active: true, created: false });

        await expect(
            client().createSubscription({
                detectionKeyHex: "ab",
                gamma: FMD_SENDER_GAMMA + 1,
                tokenHex: "cd",
            }),
        ).rejects.toMatchObject({ argument: "gamma" });
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
