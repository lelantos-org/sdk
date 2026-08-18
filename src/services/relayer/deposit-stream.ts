// Server-sent deposit lifecycle events from the relayer.
//
// A deposit is broadcast by the wallet but settled by the relayer: it picks
// the escrow up from the `DepositEscrowed` log and folds it into a
// `flushBatch`. Nothing on the deposit tx says when that landed, so the
// relayer publishes it here and `awaitFlush` is how a caller waits.
//
// Transport is injected. `EventSource` is a browser global with no Node
// equivalent (Node 24 still ships none), so a Node caller supplies a polyfill
// rather than the SDK importing one and weighing down the browser bundle.

import { type Hex32, hex32 } from "../../core/brand.js";
import { bigintFrom, int, obj, str } from "../../core/decode.js";
import { EnvironmentError } from "../../core/errors.js";
import { getLogger } from "../../log/logger.js";

const log = getLogger("lelantos:relayer:deposits");

/** Relayer confirmed the escrow was folded into a `flushBatch`. */
export interface DepositFlushed {
    kind: "flushed";
    /** `MASP.deposit` id this event settles. */
    depositId: bigint;
    chainId: bigint;
    /** Hash of the relayer's `flushBatch` tx, not the deposit tx. */
    txHash: Hex32;
    blockNumber: number;
}

/** Discriminated on `kind`; the relayer may add variants. */
export type RelayerDepositEvent = DepositFlushed;

/**
 * Outcome of {@link DepositStream.awaitFlush}, discriminated on `kind`.
 *
 * A value rather than a rejection, matching `awaitCommitments`: this runs
 * after a successful broadcast, so neither an abort nor a dead feed means the
 * deposit failed — only that its settlement went unobserved.
 *
 * The success arm *is* the event, so a narrowed `wait` reads its fields
 * directly rather than through a wrapper.
 */
export type FlushWait = DepositFlushed | { kind: "aborted" } | { kind: "closed" };

/** `EventSource.CLOSED` — the source has given up and will not reconnect. */
const READY_STATE_CLOSED = 2;

/**
 * The slice of `EventSource` this client uses.
 *
 * Structural, so a browser `EventSource`, a Node polyfill, or a test double
 * all satisfy it without a cast. `readyState` is required because it is the
 * only way to tell a transient drop the source will retry from a fatal error
 * it will not.
 */
export interface EventSourceLike {
    readonly readyState: number;
    addEventListener(type: string, listener: (ev: { data?: unknown }) => void): void;
    /**
     * Optional so a minimal custom source stays valid, but implement it where
     * possible: without it a closed stream's handlers stay attached to the
     * source for as long as the source itself is reachable.
     */
    removeEventListener?(type: string, listener: (ev: { data?: unknown }) => void): void;
    close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

export interface DepositStreamOptions {
    /**
     * Builds the underlying source. Defaults to the global `EventSource`;
     * required where there is none.
     */
    eventSourceFactory?: EventSourceFactory | undefined;
    /**
     * Events retained for replay to late subscribers. The relayer does not
     * replay, so without a buffer a flush published between broadcasting the
     * deposit and calling `awaitFlush` is missed and the caller waits for an
     * event that has already been and gone. Default 64.
     */
    replayBuffer?: number | undefined;
}

const DEFAULT_REPLAY = 64;

function decodeEvent(raw: unknown): RelayerDepositEvent | undefined {
    const d = obj(raw, "$");
    if (str(d.kind, "$.kind") !== "flushed") return undefined;
    return {
        kind: "flushed",
        depositId: bigintFrom(d.deposit_id, "$.deposit_id"),
        chainId: bigintFrom(d.chain_id, "$.chain_id"),
        txHash: hex32(str(d.tx_hash, "$.tx_hash")),
        blockNumber: int(d.block_number, "$.block_number"),
    };
}

function globalEventSourceFactory(): EventSourceFactory {
    const Ctor = (globalThis as { EventSource?: new (url: string) => EventSourceLike }).EventSource;
    if (!Ctor) {
        throw new EnvironmentError(
            "no global EventSource; pass `eventSourceFactory` to DepositStream",
        );
    }
    return (url) => new Ctor(url);
}

/**
 * Subscription to one chain's deposit events.
 *
 * The source opens on construction and stays open — the relayer heartbeats to
 * hold it through proxies, and the browser reconnects across transient drops.
 * Call {@link close} when the wallet goes away.
 *
 * ```ts
 * const stream = new DepositStream(relayerUrl, 31337n);
 * const wait = await stream.awaitFlush(depositId, { signal });
 * if (wait.kind === "flushed") console.log(wait.txHash);
 * ```
 */
export class DepositStream {
    private readonly url: string;
    private readonly source: EventSourceLike;
    private readonly replayBuffer: number;
    private readonly listeners = new Set<(ev: RelayerDepositEvent) => void>();
    private readonly closeListeners = new Set<() => void>();
    private readonly recent: DepositFlushed[] = [];
    private closed = false;

    /**
     * Retained so {@link markClosed} can detach them. An inline arrow could
     * not be removed, so every closed stream kept its handlers attached to the
     * source for as long as the source stayed reachable.
     */
    private readonly onMessageEvent = (ev: { data?: unknown }): void => this.onMessage(ev.data);
    private readonly onErrorEvent = (): void => this.onError();

    constructor(baseUrl: string, chainId: bigint, opts: DepositStreamOptions = {}) {
        this.replayBuffer = opts.replayBuffer ?? DEFAULT_REPLAY;
        this.url = `${baseUrl.replace(/\/$/, "")}/v1/deposits/stream?chain_id=${chainId}`;
        this.source = (opts.eventSourceFactory ?? globalEventSourceFactory())(this.url);
        this.source.addEventListener("message", this.onMessageEvent);
        this.source.addEventListener("error", this.onErrorEvent);
    }

    /** True once the feed can no longer deliver events. */
    get isClosed(): boolean {
        return this.closed;
    }

    /**
     * Observe every event from now on. Returns an unsubscribe function.
     *
     * A no-op once closed. Registering then would add to a set nothing drains
     * and nothing can reach: `markClosed` has already cleared it, so the
     * listener could never fire and no cleanup would ever find it.
     */
    subscribe(listener: (ev: RelayerDepositEvent) => void): () => void {
        if (this.closed) return () => {};
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /**
     * Wait for `depositId` to be flushed.
     *
     * Buffered events are matched first, so a relayer that flushed before this
     * call is still observed. Never rejects — see {@link FlushWait}.
     */
    awaitFlush(depositId: bigint, opts: { signal?: AbortSignal } = {}): Promise<FlushWait> {
        const { signal } = opts;
        const buffered = this.recent.find((ev) => ev.depositId === depositId);
        if (buffered) return Promise.resolve(buffered);
        if (signal?.aborted) return Promise.resolve({ kind: "aborted" });
        if (this.closed) return Promise.resolve({ kind: "closed" });

        return new Promise<FlushWait>((resolve) => {
            const cleanups: Array<() => void> = [];
            const settle = (result: FlushWait) => {
                for (const undo of cleanups.splice(0)) undo();
                resolve(result);
            };

            cleanups.push(
                this.subscribe((ev) => {
                    if (ev.depositId === depositId) settle(ev);
                }),
                this.onClose(() => settle({ kind: "closed" })),
            );

            if (signal) {
                const onAbort = () => settle({ kind: "aborted" });
                signal.addEventListener("abort", onAbort, { once: true });
                cleanups.push(() => signal.removeEventListener("abort", onAbort));
            }
        });
    }

    /** Release the source. Pending waiters settle as `closed`. */
    close(): void {
        if (this.closed) return;
        this.source.close();
        this.markClosed();
    }

    /**
     * Register a one-shot close callback. Returns an unregister function.
     *
     * Fires immediately on an already-closed stream: the event it waits for
     * has happened, and queueing it would leave it unreachable.
     */
    private onClose(listener: () => void): () => void {
        if (this.closed) {
            listener();
            return () => {};
        }
        this.closeListeners.add(listener);
        return () => {
            this.closeListeners.delete(listener);
        };
    }

    private onMessage(data: unknown): void {
        if (typeof data !== "string") return;
        let ev: RelayerDepositEvent | undefined;
        try {
            ev = decodeEvent(JSON.parse(data));
        } catch (e) {
            // One malformed or unrecognised frame must not tear the stream
            // down: the next may be the flush a caller is waiting on.
            log.warn("discarding undecodable deposit event", { error: String(e) });
            return;
        }
        if (!ev) return;
        this.recent.push(ev);
        if (this.recent.length > this.replayBuffer) this.recent.shift();
        for (const listener of [...this.listeners]) listener(ev);
    }

    /**
     * `error` fires on a transient drop as well as a fatal one. The browser
     * reconnects by itself in the first case, and only `readyState` tells them
     * apart — treating every error as fatal would abandon a stream that was
     * about to recover.
     */
    private onError(): void {
        if (this.source.readyState !== READY_STATE_CLOSED) {
            log.debug("deposit stream dropped; awaiting reconnect", { url: this.url });
            return;
        }
        log.warn("deposit stream closed by transport", { url: this.url });
        this.markClosed();
    }

    private markClosed(): void {
        if (this.closed) return;
        this.closed = true;
        // Detached here rather than in `close()`, so a stream the transport
        // closed under us is cleaned up too.
        this.source.removeEventListener?.("message", this.onMessageEvent);
        this.source.removeEventListener?.("error", this.onErrorEvent);
        this.listeners.clear();
        for (const listener of [...this.closeListeners]) listener();
        this.closeListeners.clear();
    }
}
