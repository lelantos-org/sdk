import { afterEach, describe, expect, it, vi } from "vitest";
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

const NOTE_ROW = {
    id: 7,
    chainId: 31337,
    blockNumber: 100,
    leafIndex: 3,
    commitmentHex: DIGITS_ONLY_CM,
    clueBitsHex: "0x00ff",
    ciphertextHex: "dead",
    ephPubX: "5",
    ephPubY: "6",
};

describe("listNotes", () => {
    it("decodes wire strings into domain values", async () => {
        respondWith([NOTE_ROW]);

        const [n] = await client().listNotes();
        if (!n) throw new Error("expected one note");

        expect(n.id).toBe(7);
        expect(n.clueBits).toBe(255);
        expect(n.ciphertext).toEqual(new Uint8Array([0xde, 0xad]));
        expect(n.ephPub).toEqual([5n, 6n]);
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
        respondWith([{ ...NOTE_ROW, ephPubY: "not-a-number" }]);

        await expect(client().listNotes()).rejects.toMatchObject({
            path: "$[0].ephPubY",
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
        const fetchMock = respondWith([{ ...rest, noteId: 42 }]);

        const [m] = await client().listMatches({ token: "abcd" });
        if (!m) throw new Error("expected one match");

        expect(m.id).toBe(42);
        const url = new URL(fetchMock.mock.calls[0]![0] as string);
        expect(url.searchParams.get("token")).toBe("abcd");
        // The subscription already pins the chain; sending chainId too would
        // only widen what the request discloses.
        expect(url.searchParams.has("chainId")).toBe(false);
    });
});

describe("chunk feeds", () => {
    it("decodes commitment entries into a cm plus a cvDep point", async () => {
        respondWith({
            chunkId: 0,
            entries: [{ leafIndex: 0, cmHex: "0a", cvDepX: "1", cvDepY: "2" }],
            isComplete: false,
        });

        const chunk = await client().fetchCommitmentChunk(0);

        expect(chunk.entries[0]).toEqual({ leafIndex: 0, cm: 10n, cvDep: [1n, 2n] });
        expect(chunk.isComplete).toBe(false);
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
        respondWith({ gamma: 8, active: true, created: false });

        await expect(
            client().createSubscription({ detectionKeyHex: "ab", gamma: 8, tokenHex: "cd" }),
        ).resolves.toEqual({ gamma: 8, active: true, created: false });
    });
});
