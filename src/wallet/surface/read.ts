// The read half of the wallet object, shared by `connect()` / `createWallet()` and `connectWatch()`.
//
// Every method is a closure over a context (never `this`), goes through `boundary()`, and rejects
// once the wallet is disposed. Nothing here reaches the spend path: `connectWatch` builds on it.

import type { ChainReader } from "../../chain/port.js";
import { settleAll } from "../../core/async.js";
import type { ShieldedAddress } from "../../core/brand.js";
import { boundary } from "../../errors/boundary.js";
import { InvalidArgumentError } from "../../errors/config.js";
import type { FullViewingKey, ViewingKey } from "../../keys/keys.js";
import {
    encodeFullViewingKey,
    encodeViewingKey,
    isFullViewingKey,
} from "../../keys/viewing-key.js";
import type { Logger } from "../../log/logger.js";
import type { CircuitShape } from "../../protocol/shape.js";
import type { ReadOnlyWalletApi, SpendingWalletKeys, WalletKeys } from "../api.js";
import type { AssetsFacade } from "../assets/facade.js";
import type { NoteLeases } from "../notes/leases.js";
import { type AwaitCommitmentsResult, awaitCommitments } from "../notes/note-cache.js";
import { balanceOf, filterNotes } from "../notes/read-ops.js";
import { type SyncContext, syncScoped } from "../notes/sync-ops.js";
import type { AwaitCommitmentsOptions, Balance, SyncOptions, SyncReport } from "../types/sync.js";
import type { WalletStateStore } from "./state.js";

/** `Symbol.asyncDispose`, or its registered stand-in on a runtime that predates it. */
const ASYNC_DISPOSE: typeof Symbol.asyncDispose = (Symbol.asyncDispose ??
    Symbol.for("Symbol.asyncDispose")) as typeof Symbol.asyncDispose;

/** What the read half runs on: a sync context plus assets, state and the chain tip. */
export interface ReadContext extends SyncContext {
    readonly address: ShieldedAddress;
    readonly assets: AssetsFacade;
    readonly shape: CircuitShape;
    /** For the chain tip (spend cooldown). Absent on a watch wallet without a reader. */
    readonly chain: ChainReader | undefined;
    /** Notes an in-flight spend holds; absent on a watch wallet, which never spends. */
    readonly leases: NoteLeases | undefined;
    readonly state: WalletStateStore;
    readonly log: Logger;
    /** The scope `sync()` runs when the caller names none; a watch wallet only has `"notes"`. */
    readonly maxScope: "notes" | "full";
    /**
     * Released by `dispose()`: the resources the SDK built for this wallet (scanner, prover). A
     * caller-supplied pluggable is never in this list.
     */
    readonly release: readonly (() => Promise<void> | void)[];
}

/**
 * Disposal gate: every method but `dispose` and `state`/`subscribe` rejects once disposed, with
 * `UNSUPPORTED_OPERATION`. The error class loads only then.
 */
export async function assertLive(state: WalletStateStore, op: string): Promise<void> {
    if (!state.disposed) return;
    const { UnsupportedOperationError } = await import("../../errors/chain.js");
    throw new UnsupportedOperationError(op, ["a live wallet (this one was disposed)"]);
}

/** The bech32m key material a wallet may hand out. */
export function walletKeysOf(keys: FullViewingKey, spending: true): SpendingWalletKeys;
export function walletKeysOf(keys: ViewingKey | FullViewingKey, spending: false): WalletKeys;
export function walletKeysOf(keys: ViewingKey | FullViewingKey, spending: boolean): WalletKeys {
    const vk: ViewingKey = { ivk: keys.ivk, pk_d: keys.pk_d, dk: keys.dk, ck: keys.ck };
    const full = isFullViewingKey(keys);
    return Object.freeze({
        tier: spending ? ("spending" as const) : full ? ("full" as const) : ("incoming" as const),
        viewingKey: encodeViewingKey(vk),
        fullViewingKey: full
            ? encodeFullViewingKey({ ...vk, nk: (keys as FullViewingKey).nk })
            : undefined,
    });
}

/** Run a public method: disposal gate, then `boundary()`. */
export function gated<T>(
    state: WalletStateStore,
    op: string,
    fn: () => Promise<T> | T,
    signal?: AbortSignal | undefined,
): Promise<T> {
    return boundary(
        op,
        async () => {
            await assertLive(state, op);
            return fn();
        },
        signal,
    );
}

/** The read-only method set, each a bound closure over `ctx`. */
export function createReadMethods(
    ctx: ReadContext,
): Omit<ReadOnlyWalletApi, "address" | "keys" | "spentKnown" | "shape"> {
    const runSync = (scope: "notes" | "full", opts: SyncOptions): Promise<SyncReport> =>
        ctx.locks.sync.run(async () => {
            ctx.state.syncStarted();
            try {
                const report = await syncScoped(ctx, scope, opts);
                ctx.state.syncSucceeded(report);
                return report;
            } catch (err) {
                ctx.state.syncFailed(err);
                throw err;
            }
        });

    const scopeOf = (requested: unknown): "notes" | "full" => {
        if (requested === undefined) return ctx.maxScope;
        if (requested !== "notes" && requested !== "full") {
            throw new InvalidArgumentError(`sync: scope must be "notes" or "full"`, {
                argument: "scope",
            });
        }
        // A watch wallet keeps no Merkle tree, so `"full"` is `"notes"` there.
        return ctx.maxScope === "notes" ? "notes" : requested;
    };

    const tip = async (): Promise<number | undefined> => ctx.chain?.blockNumber?.();

    let disposing: Promise<void> | undefined;
    const dispose = (): Promise<void> => {
        disposing ??= (async () => {
            await settleAll(
                ctx.release.map(async (r) => r()),
                (err) => ctx.log.warn("dispose failed", { err }),
            );
            await ctx.state.dispose();
        })();
        return disposing;
    };

    return {
        sync: (opts = {}) =>
            gated(
                ctx.state,
                "sync",
                () => {
                    if (typeof opts !== "object" || opts === null) {
                        throw new InvalidArgumentError("sync: options must be an object", {
                            argument: "opts",
                        });
                    }
                    return runSync(scopeOf(opts.scope), opts);
                },
                opts?.signal,
            ),

        awaitCommitments: (cms, opts: AwaitCommitmentsOptions = {}) =>
            gated(
                ctx.state,
                "awaitCommitments",
                (): Promise<AwaitCommitmentsResult> => {
                    if (!Array.isArray(cms) || cms.some((c) => typeof c !== "string")) {
                        throw new InvalidArgumentError(
                            "awaitCommitments: cms must be an array of 0x-hex commitments",
                            { argument: "cms" },
                        );
                    }
                    // Polls `sync` rather than throwing on timeout: a lagging indexer after a
                    // broadcast is not a failed transaction. Notes and the spent set are what a
                    // commitment appears in; the tree syncs when a spend needs it.
                    return awaitCommitments(
                        cms,
                        () => ctx.notes.notes,
                        (pageSize) => runSync("notes", pageSize === undefined ? {} : { pageSize }),
                        opts,
                    );
                },
                opts?.signal,
            ),

        state: () => ctx.state.state(),
        subscribe: (listener) => {
            if (typeof listener !== "function") {
                throw new InvalidArgumentError("subscribe: listener must be a function", {
                    argument: "listener",
                });
            }
            return ctx.state.subscribe(listener);
        },

        balance: (ref) =>
            gated(ctx.state, "balance", async (): Promise<Balance> => {
                const asset = await ctx.assets.resolveVerified(ref);
                const tipBlock = await tip();
                // Loaded on demand, like the amount arithmetic below: a wallet that only syncs and
                // lists notes (a watch dashboard) never downloads the selection rules.
                const { spendableMax } = await import("../selection/spendable-max.js");
                const notes = ctx.notes.notes;
                const { max, withheld } = spendableMax(
                    notes,
                    asset.id,
                    {
                        maxInputs: ctx.shape.nIn,
                        ...(tipBlock !== undefined ? { tipBlock } : {}),
                    },
                    ctx.leases,
                );
                return Object.freeze({
                    asset,
                    total: balanceOf(notes, asset.id),
                    spendable: max,
                    withheld: Object.freeze(withheld),
                    syncedAt: ctx.state.lastSyncedAt,
                });
            }),

        notes: (filter = {}) =>
            gated(ctx.state, "notes", () => filterNotes(ctx.notes.notes, filter)),

        asset: (ref, opts = {}) =>
            gated(ctx.state, "asset", () =>
                opts.refresh ? ctx.assets.refresh(ref) : ctx.assets.resolveVerified(ref),
            ),

        assets: () => gated(ctx.state, "assets", () => ctx.assets.list()),

        previewWithdraw: (args) =>
            gated(ctx.state, "previewWithdraw", async () => {
                if (typeof args !== "object" || args === null) {
                    throw new InvalidArgumentError("previewWithdraw: pass { asset, gross | net }", {
                        argument: "args",
                    });
                }
                const [asset, { resolveOutAmount }, { previewWithdraw }] = await Promise.all([
                    ctx.assets.resolveVerified(args.asset),
                    import("../assets/amount.js"),
                    import("../ops/withdraw-preview.js"),
                ]);
                const { gross } = resolveOutAmount(args, asset, "previewWithdraw");
                return previewWithdraw({ amount: gross, asset });
            }),

        withdrawDenominations: (ref) =>
            gated(ctx.state, "withdrawDenominations", async () => {
                const { denominationChoices } = await import("../ops/withdraw-preview.js");
                return denominationChoices(await ctx.assets.resolveVerified(ref));
            }),

        compact: () => gated(ctx.state, "compact", () => ctx.notes.compact()),

        dispose,
        [ASYNC_DISPOSE]: dispose,
    };
}
