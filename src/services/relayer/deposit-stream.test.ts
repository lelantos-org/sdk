import { describe, expect, it } from "vitest";
import { isWalletError } from "../../core/errors.js";
import { DepositStream, type EventSourceLike } from "./deposit-stream.js";

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

/// Stands in for the browser global. `readyState` is settable so a test can
/// distinguish a transient drop from a fatal close, as the real one does.
class FakeSource implements EventSourceLike {
    static last: FakeSource | undefined;
    readonly url: string;
    readyState = OPEN;
    closeCalls = 0;
    private readonly handlers = new Map<string, (ev: { data?: unknown }) => void>();

    constructor(url: string) {
        this.url = url;
        FakeSource.last = this;
    }

    addEventListener(type: string, listener: (ev: { data?: unknown }) => void): void {
        this.handlers.set(type, listener);
    }

    removeEventListener(type: string, listener: (ev: { data?: unknown }) => void): void {
        if (this.handlers.get(type) === listener) this.handlers.delete(type);
    }

    /** Handler types still attached, for leak assertions. */
    get attached(): string[] {
        return [...this.handlers.keys()].sort();
    }

    close(): void {
        this.closeCalls += 1;
        this.readyState = CLOSED;
    }

    emit(payload: unknown): void {
        this.handlers.get("message")?.({ data: JSON.stringify(payload) });
    }

    emitRaw(data: unknown): void {
        this.handlers.get("message")?.({ data });
    }

    /** Fatal error: the browser has given up. */
    fail(): void {
        this.readyState = CLOSED;
        this.handlers.get("error")?.({});
    }

    /** Transient drop: the browser will reconnect. */
    drop(): void {
        this.readyState = CONNECTING;
        this.handlers.get("error")?.({});
    }
}

const TX = `0x${"ab".repeat(32)}`;

function flushed(depositId: number, chainId = 31337) {
    return {
        kind: "flushed",
        deposit_id: depositId,
        chain_id: chainId,
        tx_hash: TX,
        block_number: 42,
    };
}

function stream(chainId = 31337n, replayBuffer?: number) {
    const s = new DepositStream("http://relayer.test", chainId, {
        eventSourceFactory: (url) => new FakeSource(url),
        replayBuffer,
    });
    return { s, src: FakeSource.last as FakeSource };
}

describe("DepositStream", () => {
    describe("connection", () => {
        it("targets the relayer's per-chain SSE route", () => {
            expect(stream(42161n).src.url).toBe(
                "http://relayer.test/v1/deposits/stream?chain_id=42161",
            );
        });

        it("tolerates a trailing slash on the base url", () => {
            new DepositStream("http://relayer.test/", 1n, {
                eventSourceFactory: (url) => new FakeSource(url),
            });
            expect(FakeSource.last?.url).toBe("http://relayer.test/v1/deposits/stream?chain_id=1");
        });

        it("reports a missing global as an environment problem", () => {
            const err = (() => {
                try {
                    new DepositStream("http://relayer.test", 1n);
                } catch (e) {
                    return e;
                }
            })();
            expect(isWalletError(err, "ENVIRONMENT")).toBe(true);
            expect((err as Error).message).toMatch(/EventSource/);
        });
    });

    describe("decoding", () => {
        it("maps the relayer's snake_case wire shape onto branded fields", async () => {
            const { s, src } = stream();
            const pending = s.awaitFlush(7n);
            src.emit(flushed(7));
            await expect(pending).resolves.toEqual({
                kind: "flushed",
                depositId: 7n,
                chainId: 31337n,
                txHash: TX,
                blockNumber: 42,
            });
        });

        // A heartbeat comment, an unknown event kind, or a malformed frame
        // must not tear down a stream a caller is still waiting on.
        it("survives undecodable and unrecognised frames", async () => {
            const { s, src } = stream();
            const pending = s.awaitFlush(5n);
            src.emitRaw("not json");
            src.emitRaw(undefined);
            src.emit({ kind: "queued", deposit_id: 5 });
            src.emit({ kind: "flushed", deposit_id: "nope" });
            expect(s.isClosed).toBe(false);
            src.emit(flushed(5));
            await expect(pending).resolves.toMatchObject({ kind: "flushed" });
        });
    });

    describe("awaitFlush", () => {
        it("resolves only the waiter whose deposit id matches", async () => {
            const { s, src } = stream();
            const wanted = s.awaitFlush(2n);
            src.emit(flushed(1));
            src.emit(flushed(2));
            await expect(wanted).resolves.toMatchObject({ depositId: 2n });
        });

        // The relayer does not replay, so a flush published between
        // broadcasting the deposit and awaiting it must still be matchable.
        it("matches a flush buffered before the waiter existed", async () => {
            const { s, src } = stream();
            src.emit(flushed(9));
            await expect(s.awaitFlush(9n)).resolves.toMatchObject({ depositId: 9n });
        });

        it("bounds the replay buffer", async () => {
            const { s, src } = stream(31337n, 2);
            src.emit(flushed(1));
            src.emit(flushed(2));
            src.emit(flushed(3));
            await expect(s.awaitFlush(3n)).resolves.toMatchObject({ kind: "flushed" });
            // 1 was evicted, so nothing buffered can settle it.
            const evicted = s.awaitFlush(1n);
            s.close();
            await expect(evicted).resolves.toEqual({ kind: "closed" });
        });

        it("reports an abort without rejecting", async () => {
            const { s, src } = stream();
            const ctrl = new AbortController();
            const pending = s.awaitFlush(1n, { signal: ctrl.signal });
            ctrl.abort();
            await expect(pending).resolves.toEqual({ kind: "aborted" });
            // A late event must not resurface on the settled waiter.
            src.emit(flushed(1));
        });

        it("reports an already-aborted signal without subscribing", async () => {
            const { s } = stream();
            await expect(s.awaitFlush(1n, { signal: AbortSignal.abort() })).resolves.toEqual({
                kind: "aborted",
            });
        });

        it("prefers a buffered flush over an already-aborted signal", async () => {
            const { s, src } = stream();
            src.emit(flushed(4));
            await expect(s.awaitFlush(4n, { signal: AbortSignal.abort() })).resolves.toMatchObject({
                kind: "flushed",
            });
        });
    });

    describe("closing", () => {
        // A fatal transport error settles waiters instead of leaving them to
        // wait out a caller-side timeout against a source that is gone.
        it("settles waiters when the transport gives up", async () => {
            const { s, src } = stream();
            const pending = s.awaitFlush(1n);
            src.fail();
            await expect(pending).resolves.toEqual({ kind: "closed" });
            expect(s.isClosed).toBe(true);
        });

        // The browser reconnects by itself here; abandoning the stream would
        // drop a flush that is still coming.
        it("stays open across a transient drop", async () => {
            const { s, src } = stream();
            const pending = s.awaitFlush(1n);
            src.drop();
            expect(s.isClosed).toBe(false);
            src.readyState = OPEN;
            src.emit(flushed(1));
            await expect(pending).resolves.toMatchObject({ kind: "flushed" });
        });

        it("settles waiters on an explicit close", async () => {
            const { s } = stream();
            const pending = s.awaitFlush(1n);
            s.close();
            await expect(pending).resolves.toEqual({ kind: "closed" });
        });

        it("reports closed immediately once shut", async () => {
            const { s } = stream();
            s.close();
            await expect(s.awaitFlush(1n)).resolves.toEqual({ kind: "closed" });
        });

        it("releases the underlying source exactly once", () => {
            const { s, src } = stream();
            s.close();
            s.close();
            expect(src.closeCalls).toBe(1);
        });

        it("does not re-close a source the transport already dropped", () => {
            const { s, src } = stream();
            src.fail();
            s.close();
            expect(src.closeCalls).toBe(0);
        });
    });

    describe("subscribe", () => {
        it("delivers until unsubscribed", () => {
            const { s, src } = stream();
            const seen: bigint[] = [];
            const off = s.subscribe((ev) => seen.push(ev.depositId));
            src.emit(flushed(1));
            off();
            src.emit(flushed(2));
            expect(seen).toEqual([1n]);
        });
    });
});

describe("DepositStream teardown", () => {
    it("detaches its transport handlers on close", async () => {
        // The handlers were inline arrows, so nothing could remove them: every
        // closed stream stayed attached to its source for as long as the
        // source was reachable.
        const stream = new DepositStream("http://relayer.test", 1n, {
            eventSourceFactory: (url) => new FakeSource(url),
        });
        const source = FakeSource.last;
        if (!source) throw new Error("no source");

        expect(source.attached).toEqual(["error", "message"]);

        stream.close();

        expect(source.attached).toEqual([]);
    });

    it("detaches when the transport closes the stream, not just on close()", async () => {
        const stream = new DepositStream("http://relayer.test", 1n, {
            eventSourceFactory: (url) => new FakeSource(url),
        });
        const source = FakeSource.last;
        if (!source) throw new Error("no source");

        source.fail();

        expect(stream.isClosed).toBe(true);
        expect(source.attached).toEqual([]);
    });

    it("ignores a subscriber registered after close", async () => {
        // `markClosed` clears the listener set, so a later `subscribe` added to
        // a set nothing drains — unreachable, and never cleaned up.
        const stream = new DepositStream("http://relayer.test", 1n, {
            eventSourceFactory: (url) => new FakeSource(url),
        });
        stream.close();

        const seen: unknown[] = [];
        const unsubscribe = stream.subscribe((ev) => seen.push(ev));

        expect(() => unsubscribe()).not.toThrow();
        expect(seen).toEqual([]);
    });

    it("settles a waiter on an already-closed stream", async () => {
        const stream = new DepositStream("http://relayer.test", 1n, {
            eventSourceFactory: (url) => new FakeSource(url),
        });
        stream.close();

        await expect(stream.awaitFlush(1n)).resolves.toEqual({ kind: "closed" });
    });
});
