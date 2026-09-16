// Observable wallet state: an immutable snapshot, rebuilt after a change commits and announced
// once per microtask.
//
// `state()` returns the same object until something changes, so it can back React's
// `useSyncExternalStore(wallet.subscribe, wallet.state)` directly: a stable snapshot between
// changes, a new identity after one.

import { type AssetId, branded, type CircuitAmount } from "../../core/brand.js";
import type { WalletError } from "../../errors/base.js";
import { isWalletError } from "../../errors/guard.js";
import { getLogger } from "../../log/logger.js";
import type { NoteCache } from "../notes/note-cache.js";
import { withinReservation } from "../notes/note-store.js";
import type { Phase } from "../types/options.js";
import type { OpActivity, StateListener, SyncReport, WalletState } from "../types/sync.js";

const log = getLogger("lelantos:wallet:state");

/** Owns the snapshot, the listeners and the facts the snapshot is built from. */
export class WalletStateStore {
    private snapshot: WalletState;
    private dirty = false;
    private scheduled = false;
    private lastEmitted: WalletState | undefined;
    private readonly listeners = new Set<StateListener>();

    private syncing = 0;
    private syncedAt: Date | undefined;
    private lastReport: SyncReport | undefined;
    private lastError: WalletError | undefined;
    private readonly ops = new Map<string, OpActivity>();
    private isDisposed = false;

    constructor(private readonly notes: NoteCache) {
        this.snapshot = this.build(0);
        this.lastEmitted = this.snapshot;
        notes.onChange(() => this.changed());
    }

    /** The current snapshot. Same object until the next change. */
    state(): WalletState {
        if (this.dirty) {
            this.snapshot = this.build(this.snapshot.version + 1);
            this.dirty = false;
        }
        return this.snapshot;
    }

    /** Idempotent unsubscribe; not called on subscribe. */
    subscribe(listener: StateListener): () => void {
        if (this.isDisposed) return () => undefined;
        const entry: StateListener = (s) => listener(s);
        this.listeners.add(entry);
        return () => {
            this.listeners.delete(entry);
        };
    }

    get disposed(): boolean {
        return this.isDisposed;
    }

    /** When the notes behind a balance last synced. */
    get lastSyncedAt(): Date | undefined {
        return this.syncedAt;
    }

    // --- facts ---------------------------------------------------------------------------------

    syncStarted(): void {
        this.syncing++;
        if (this.syncing === 1) this.changed();
    }

    syncSucceeded(report: SyncReport): void {
        this.syncing = Math.max(0, this.syncing - 1);
        this.syncedAt = report.syncedAt;
        this.lastReport = report;
        this.lastError = undefined;
        this.changed();
    }

    syncFailed(err: unknown): void {
        this.syncing = Math.max(0, this.syncing - 1);
        // An abort by the caller is not a sync failure worth surfacing.
        if (isWalletError(err)) this.lastError = err as WalletError;
        this.changed();
    }

    opStarted(opId: string, op: OpActivity["op"]): void {
        this.ops.set(opId, Object.freeze({ opId, op, phase: undefined, startedAt: new Date() }));
        this.changed();
    }

    opPhase(opId: string, phase: Phase): void {
        const cur = this.ops.get(opId);
        if (!cur || cur.phase === phase) return;
        this.ops.set(opId, Object.freeze({ ...cur, phase }));
        this.changed();
    }

    opSettled(opId: string): void {
        if (this.ops.delete(opId)) this.changed();
    }

    /** Final emission, delivered before the listeners are cleared. */
    async dispose(): Promise<void> {
        if (this.isDisposed) return;
        this.isDisposed = true;
        this.changed();
        this.flush();
        this.listeners.clear();
        this.notes.onChange(undefined);
    }

    // --- emission ------------------------------------------------------------------------------

    private changed(): void {
        this.dirty = true;
        if (this.scheduled || this.listeners.size === 0) return;
        this.scheduled = true;
        queueMicrotask(() => this.flush());
    }

    private flush(): void {
        this.scheduled = false;
        const snapshot = this.state();
        if (snapshot === this.lastEmitted) return;
        this.lastEmitted = snapshot;
        for (const listener of [...this.listeners]) {
            try {
                listener(snapshot);
            } catch (err) {
                log.warn("state listener threw; ignored", { err });
            }
        }
    }

    private build(version: number): WalletState {
        const now = Date.now();
        let unspent = 0;
        let pendingSpend = 0;
        const totals = new Map<AssetId, CircuitAmount>();
        for (const n of this.notes.notes) {
            if (n.spent) continue;
            unspent++;
            if (withinReservation(n.pendingSpendAt, now)) pendingSpend++;
            let asset: AssetId;
            let value: bigint;
            try {
                asset = branded<AssetId>(BigInt(n.asset));
                value = BigInt(n.value);
            } catch {
                // A corrupt stored note is reported by the reads that parse it (`INTERNAL`); a
                // snapshot must never throw, since it is built inside a microtask.
                continue;
            }
            totals.set(asset, branded<CircuitAmount>((totals.get(asset) ?? 0n) + value));
        }
        return Object.freeze({
            version,
            sync: Object.freeze({
                status: this.syncing > 0 ? ("syncing" as const) : ("idle" as const),
                syncedAt: this.syncedAt,
                lastReport: this.lastReport,
                lastError: this.lastError,
            }),
            notes: Object.freeze({ count: this.notes.notes.length, unspent, pendingSpend }),
            balances: totals as ReadonlyMap<AssetId, CircuitAmount>,
            ops: Object.freeze(
                [...this.ops.values()].sort(
                    (a, b) => a.startedAt.getTime() - b.startedAt.getTime(),
                ),
            ),
            disposed: this.isDisposed,
        });
    }
}
