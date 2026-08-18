import { afterEach, describe, expect, it, vi } from "vitest";
import { isWalletError, WalletConfigError } from "../core/errors.js";
import { configureLogging, loggingConfig } from "../log/logger.js";
import { createWorkerRpc } from "./client.js";
import { fromWireError, toWireError } from "./error-wire.js";
import { type Handlers, serveWorkerRpc } from "./serve.js";
import type { RpcRequest, RpcResponse, WorkerLike, WorkerScopeLike } from "./types.js";

type TestMethods = {
    echo: { params: { v: number }; result: number };
    slow: { params: Record<string, never>; result: string };
    boom: { params: Record<string, never>; result: never };
};

/**
 * In-memory worker double. No real Worker is spawned: these tests target the
 * correlation logic, and a real spawn is flaky across Node/browser under
 * `pool: "forks"`.
 */
class FakeWorker implements WorkerLike {
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    onmessageerror: ((ev: unknown) => void) | null = null;
    terminated = false;
    readonly sent: RpcRequest[] = [];
    readonly transfers: (readonly unknown[] | undefined)[] = [];
    /** Set to hold requests so the test can answer them out of order. */
    manual = false;

    postMessage(msg: unknown, transfer?: readonly unknown[]): void {
        this.sent.push(msg as RpcRequest);
        this.transfers.push(transfer);
    }

    terminate(): void {
        this.terminated = true;
    }

    /** Deliver a response from the "worker" side. */
    reply(res: RpcResponse): void {
        this.onmessage?.({ data: res });
    }

    crash(message = "boom"): void {
        this.onerror?.({ message });
    }

    cloneFailure(): void {
        this.onmessageerror?.({});
    }
}

function rpc(worker: FakeWorker, timeouts?: Record<string, number>) {
    return createWorkerRpc<TestMethods>(worker, { name: "test", timeouts });
}

afterEach(() => {
    vi.useRealTimers();
});

describe("createWorkerRpc", () => {
    it("resolves each caller with its own response, out of order", async () => {
        const w = new FakeWorker();
        const c = rpc(w);

        const a = c.call("echo", { v: 1 });
        const b = c.call("echo", { v: 2 });

        expect(w.sent.map((m) => m.id)).toEqual([1, 2]);
        // Answer in reverse — the id map, not arrival order, decides.
        w.reply({ id: 2, ok: true, result: 20 });
        w.reply({ id: 1, ok: true, result: 10 });

        expect(await a).toBe(10);
        expect(await b).toBe(20);
    });

    // The client holds one persistent `onmessage` handler and correlates by
    // id. A per-call save/replace/restore of the handler would let two
    // concurrent calls clobber each other, leaving one unsettled.
    it("settles both of two concurrent calls on one worker", async () => {
        const w = new FakeWorker();
        const c = rpc(w);

        const both = Promise.all([c.call("echo", { v: 1 }), c.call("echo", { v: 2 })]);
        w.reply({ id: 1, ok: true, result: 1 });
        w.reply({ id: 2, ok: true, result: 2 });

        await expect(both).resolves.toEqual([1, 2]);
    });

    it("rejects every in-flight call when the worker crashes", async () => {
        const w = new FakeWorker();
        const c = rpc(w);

        const a = c.call("echo", { v: 1 });
        const b = c.call("slow", {});
        w.crash("segfault");

        await expect(a).rejects.toThrow(/segfault/);
        await expect(b).rejects.toThrow(/segfault/);
        expect(c.alive).toBe(false);
    });

    it("rejects immediately once the worker is dead, instead of hanging", async () => {
        const w = new FakeWorker();
        const c = rpc(w);
        w.crash();
        await expect(c.call("echo", { v: 1 })).rejects.toThrow(/no longer running/);
    });

    it("rejects on an undeserialisable response rather than dropping it", async () => {
        const w = new FakeWorker();
        const c = rpc(w);
        const p = c.call("echo", { v: 1 });
        w.cloneFailure();
        await expect(p).rejects.toThrow(/deserialis/);
    });

    it("times out and clears the pending entry", async () => {
        vi.useFakeTimers();
        const w = new FakeWorker();
        const c = rpc(w, { slow: 1000 });

        const p = c.call("slow", {});
        vi.advanceTimersByTime(1001);
        await expect(p).rejects.toThrow(/timed out/);

        // A late reply must not throw or resolve anything.
        expect(() => w.reply({ id: 1, ok: true, result: "late" })).not.toThrow();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("carries the error code and call context on a timeout", async () => {
        vi.useFakeTimers();
        const w = new FakeWorker();
        const c = rpc(w, { slow: 50 });
        const p = c.call("slow", {}, { context: { chunk: 7 } });
        vi.advanceTimersByTime(51);

        const err = await p.catch((e) => e);
        expect(isWalletError(err, "WORKER_TIMEOUT")).toBe(true);
        expect(err.context).toMatchObject({ chunk: 7, timeoutMs: 50 });
    });

    it("round-trips a remote error's name, stack and code into cause", async () => {
        const w = new FakeWorker();
        const c = rpc(w);
        const p = c.call("boom", {});

        const remote = new WalletConfigError("relayerUrl missing");
        remote.stack =
            "WalletConfigError: relayerUrl missing\n    at insideTheWorker (worker.js:9:1)";
        w.reply({ id: 1, ok: false, error: toWireError(remote) });

        const err = await p.catch((e) => e);
        expect(err.name).toBe("WalletConfigError");
        expect(err.message).toBe("wallet config: relayerUrl missing");
        expect(err.code).toBe("WALLET_CONFIG");
        // The worker's own frames survive the hop.
        expect(err.stack).toContain("insideTheWorker");
    });

    it("rejects pending calls on dispose and terminates the worker", async () => {
        const w = new FakeWorker();
        const c = rpc(w);
        const p = c.call("echo", { v: 1 });
        c.dispose("shutting down");

        await expect(p).rejects.toThrow(/shutting down/);
        expect(w.terminated).toBe(true);
        expect(c.alive).toBe(false);
    });

    it("passes the transfer list through to postMessage", async () => {
        const w = new FakeWorker();
        const c = rpc(w);
        const buf = new ArrayBuffer(8);
        void c.call("echo", { v: 1 }, { transfer: [buf] });
        expect(w.transfers[0]).toEqual([buf]);
    });
});

describe("serveWorkerRpc", () => {
    /** Loops the client and the server halves together in one process. */
    function wire(handlers: Handlers<TestMethods>) {
        const w = new FakeWorker();
        const scope: WorkerScopeLike = {
            onmessage: null,
            postMessage: (msg: unknown) => w.reply(msg as RpcResponse),
        };
        serveWorkerRpc<TestMethods>(handlers, { scope });
        w.postMessage = (msg: unknown) => {
            w.sent.push(msg as RpcRequest);
            scope.onmessage?.({ data: msg });
        };
        return rpc(w);
    }

    it("dispatches to the handler and returns its result", async () => {
        const c = wire({
            echo: ({ v }) => v * 2,
            slow: async () => "ok",
            boom: () => {
                throw new Error("nope");
            },
        });
        expect(await c.call("echo", { v: 21 })).toBe(42);
    });

    it("turns a handler throw into a rejection carrying the message", async () => {
        const c = wire({
            echo: () => 0,
            slow: async () => "ok",
            boom: () => {
                throw new WalletConfigError("bad wiring");
            },
        });
        const err = await c.call("boom", {}).catch((e) => e);
        expect(err.message).toContain("bad wiring");
        expect(err.code).toBe("WALLET_CONFIG");
    });

    it("rejects an unknown method instead of hanging", async () => {
        const c = wire({
            echo: () => 0,
            slow: async () => "ok",
            boom: () => {
                throw new Error("x");
            },
        });
        await expect(
            (c as unknown as { call: (m: string, p: unknown) => Promise<unknown> }).call(
                "nope",
                {},
            ),
        ).rejects.toThrow(/unknown method/);
    });
});

// The logging handshake. A worker is a separate module realm and starts at
// `silent`, so `timed()` spans short-circuit there and the forwarding sink
// installed by `forwardLogs` never receives anything. These pin both halves:
// the client announcing its config, and the worker applying it.
//
// Deliberately not an end-to-end round trip — in one process
// `installLogForwarder` replaces the same module-global sink the client reads
// from, so a forwarded record would feed straight back into the forwarder.
describe("log config handshake", () => {
    const saved = loggingConfig();
    afterEach(() => configureLogging({ ...saved, sink: null }));

    it("posts nothing when logging is off", () => {
        configureLogging({ level: "silent", sink: null, namespaces: null });
        const w = new FakeWorker();
        createWorkerRpc<TestMethods>(w);
        // The overwhelmingly common path: no control message at all.
        expect(w.sent).toEqual([]);
    });

    it("announces level and namespaces as globs, not compiled regexes", () => {
        configureLogging({
            level: "debug",
            sink: () => {},
            namespaces: "lelantos:prover:*",
        });
        const w = new FakeWorker();
        createWorkerRpc<TestMethods>(w);

        // `.source` of the compiled matcher would be `^lelantos:prover:.*$`,
        // which `configureLogging` would then re-escape into a literal.
        expect(w.sent).toEqual([
            { kind: "log-config", level: "debug", namespaces: ["lelantos:prover:*"] },
        ]);
    });

    it("is applied by the worker side and is not treated as a call", async () => {
        configureLogging({ level: "silent", sink: null, namespaces: null });
        const scope: WorkerScopeLike = { onmessage: null, postMessage: () => {} };
        const echo = vi.fn(({ v }: { v: number }) => v);
        serveWorkerRpc<TestMethods>(
            {
                echo,
                slow: async () => "ok",
                boom: () => {
                    throw new Error("x");
                },
            },
            { scope },
        );

        scope.onmessage?.({
            data: { kind: "log-config", level: "debug", namespaces: ["lelantos:a:*"] },
        });
        await Promise.resolve();

        expect(loggingConfig()).toEqual({ level: "debug", namespaces: ["lelantos:a:*"] });
        // A control message must not be mistaken for an RPC request.
        expect(echo).not.toHaveBeenCalled();
    });
});

describe("createWorkerRpc abort", () => {
    it("rejects an already-aborted call without posting to the worker", async () => {
        const w = new FakeWorker();
        const rpc = createWorkerRpc<TestMethods>(w, { name: "t" });

        // `addEventListener("abort", …)` does not fire for a signal that has
        // already aborted, so this used to be posted and left pending forever
        // whenever the method had no timeout configured.
        await expect(
            rpc.call("echo", { v: 1 }, { signal: AbortSignal.abort(new Error("gone")) }),
        ).rejects.toThrow("gone");

        expect(w.sent).toHaveLength(0);
    });

    it("still settles a call aborted after it was posted", async () => {
        const w = new FakeWorker();
        const rpc = createWorkerRpc<TestMethods>(w, { name: "t" });
        const ctrl = new AbortController();

        const call = rpc.call("echo", { v: 1 }, { signal: ctrl.signal });
        expect(w.sent).toHaveLength(1);

        ctrl.abort(new Error("cancelled"));
        await expect(call).rejects.toThrow("cancelled");
    });

    it("stops accepting work once a response could not be deserialised", async () => {
        const w = new FakeWorker();
        const rpc = createWorkerRpc<TestMethods>(w, { name: "t" });

        const inFlight = rpc.call("echo", { v: 1 });
        w.onmessageerror?.({});

        await expect(inFlight).rejects.toThrow(/deserialised/);
        // The id of the dropped reply is unrecoverable, so the transport has
        // proved it can silently lose replies — it must not take new work.
        expect(rpc.alive).toBe(false);
        await expect(rpc.call("echo", { v: 2 })).rejects.toThrow(/no longer running/);
    });
});

describe("worker error wire", () => {
    it("carries a typed error's own fields across the boundary", async () => {
        // `isWalletError(e, code)` is duck-typed on `code`, so it narrowed
        // even before — but the narrowed type was a lie: every field a
        // subclass adds read back `undefined`.
        const rich = new WalletConfigError(["`relayerUrl`"]);
        const wire = toWireError(rich);
        const back = fromWireError(wire);

        expect(isWalletError(back)).toBe(true);
        expect((back as unknown as { missing?: string[] }).missing).toEqual(["`relayerUrl`"]);
    });

    it("keeps code and context alongside the fields", async () => {
        const err = new WalletConfigError(["`chainId`"]);
        err.context.opId = "op-1";

        const back = fromWireError(toWireError(err));

        expect((back as unknown as { code?: string }).code).toBe("WALLET_CONFIG");
        expect((back as unknown as { context?: { opId?: string } }).context?.opId).toBe("op-1");
    });

    it("drops values structured clone would reject", async () => {
        // A function on the error would throw at `postMessage` and cost the
        // whole reply — the failure this wire format exists to avoid.
        const err = new WalletConfigError(["`x`"]);
        (err as unknown as { retry: () => void }).retry = () => {};

        const wire = toWireError(err);

        expect(wire.fields?.retry).toBeUndefined();
        expect(wire.fields?.missing).toEqual(["`x`"]);
    });
});
