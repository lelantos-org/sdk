// `createWalletApi(ctx)`: the frozen wallet object `connect()` and `createWallet()` return.
//
// Methods are closures bound over the `WalletContext`, so `const { sync } = wallet` works; each runs
// through `boundary()`. The spend path loads with `await import(...)`, so a wallet that never
// spends never downloads the prover, the bundle builders or viem.
//
// Spends and quotes live in `./spend.ts`; deposits, cancels and Permit2 setup in `./deposit.ts`.

import { supportsNativeEth, supportsSigning } from "../../chain/port.js";
import { boundary } from "../../errors/boundary.js";
import type { WalletApi, WalletCapabilities } from "../api.js";
import type { WalletContext } from "../context.js";
import type { ProverHandle } from "../defaults/prover.js";
import { reconcileSpentOnChain } from "../notes/sync-ops.js";
import type { DepositEscrow } from "../types/results.js";
import type { AwaitCommitmentsOptions } from "../types/sync.js";
import type { DepositMethods } from "./deposit.js";
import { registerInternals, type WalletInternals } from "./internals.js";
import { createReadMethods, gated, type ReadContext, walletKeysOf } from "./read.js";
import type { SpendEnv, SpendMethods } from "./spend.js";
import type { WalletStateStore } from "./state.js";

/** What the wallet object holds besides its context. */
export interface WalletApiExtras {
    readonly state: WalletStateStore;
    readonly prover: ProverHandle;
    /** Whether the SDK built `ctx.cfg.scanner` (and so `dispose()` releases it). */
    readonly scannerOwned: boolean;
}

/** Capabilities, fixed at construction. */
function capabilitiesOf(ctx: Pick<WalletContext, "cfg">, prove: boolean): WalletCapabilities {
    const { chain, submitter } = ctx.cfg;
    return Object.freeze({
        prove,
        deposit: supportsSigning(chain),
        depositAllowance:
            supportsSigning(chain) &&
            typeof (chain as { signPermit2AllowanceBatch?: unknown }).signPermit2AllowanceBatch ===
                "function",
        nativeDeposit: supportsNativeEth(chain),
        nativeWithdraw: chain.nativeAdapterAddress?.() !== undefined,
        swap: prove && typeof submitter.submitSwap === "function" && !!ctx.cfg.quoterUrl,
    });
}

export function createWalletApi(ctx: WalletContext, extras: WalletApiExtras): WalletApi {
    const { state } = extras;
    const readCtx: ReadContext = {
        ...ctx,
        shape: ctx.cfg.shape,
        chain: ctx.cfg.chain,
        state,
        maxScope: "full",
        // Only what the SDK built: a caller-supplied prover or scanner outlives the wallet.
        release: [
            ...(extras.scannerOwned ? [() => ctx.cfg.scanner.dispose?.()] : []),
            ...(extras.prover.owned ? [() => extras.prover.prover.dispose?.()] : []),
        ],
    };
    const read = createReadMethods(readCtx);

    const env: SpendEnv = {
        ctx,
        extras,
        awaitCommitments: (cms, opts) => read.awaitCommitments(cms, opts),
    };
    // Each module loads on first use; a failed load is retried on the next call.
    const loader = <T>(load: () => Promise<T>) => {
        let loaded: Promise<T> | undefined;
        return (): Promise<T> => {
            loaded ??= load().catch((err: unknown) => {
                loaded = undefined;
                throw err;
            });
            return loaded;
        };
    };
    const spend = loader(() => import("./spend.js").then((m) => m.spendMethods(env)));
    const deposits = loader(() => import("./deposit.js").then((m) => m.depositMethods(env)));
    // Only the module load needs a boundary here: every method runs under its own.
    const lazy =
        <M, K extends keyof M & string>(load: () => Promise<M>, op: K) =>
        async (...args: unknown[]) => {
            const methods = await boundary(op, load);
            return (methods[op] as (...a: unknown[]) => Promise<unknown>)(...args);
        };

    const s = <K extends keyof SpendMethods>(op: K) => lazy(spend, op) as SpendMethods[K];
    const d = <K extends keyof DepositMethods>(op: K) => lazy(deposits, op) as DepositMethods[K];

    const api: WalletApi = Object.freeze({
        address: ctx.address,
        keys: walletKeysOf(ctx.keys, true),
        spentKnown: true,
        shape: ctx.cfg.shape,
        chain: ctx.cfg.chain,
        capabilities: capabilitiesOf(ctx, extras.prover.available),
        ...read,
        warmProver: (opts: { signal?: AbortSignal | undefined } = {}) =>
            gated(state, "warmProver", () => extras.prover.warm(), opts?.signal),
        quoteFee: s("quoteFee"),
        spendableMax: s("spendableMax"),
        quoteDeposit: d("quoteDeposit"),
        quoteSwap: s("quoteSwap"),
        deposit: d("deposit"),
        awaitDeposit: (escrow: DepositEscrow, opts?: AwaitCommitmentsOptions) => {
            const commitment = (escrow as DepositEscrow | null)?.commitment;
            // Anything but an escrow reaches `awaitCommitments` as a non-array, which it refuses.
            return read.awaitCommitments(
                typeof commitment === "string" ? [commitment] : (null as unknown as string[]),
                opts,
            );
        },
        cancelDeposit: d("cancelDeposit"),
        setupDepositAllowance: d("setupDepositAllowance"),
        transfer: s("transfer"),
        withdraw: s("withdraw"),
        swap: s("swap"),
        redenominate: s("redenominate"),
    });

    registerInternals(api, spendingInternals(ctx, extras));
    return api;
}

function spendingInternals(ctx: WalletContext, extras: WalletApiExtras): WalletInternals {
    return {
        P: ctx.P,
        J: ctx.J,
        keys: ctx.keys,
        noteStore: ctx.notes.store,
        noteSource: ctx.cfg.noteSource,
        nullifierStore: ctx.cfg.nullifierStore,
        scanner: ctx.cfg.scanner,
        nullifiers: ctx.nullifiers,
        cache: ctx.notes,
        get file() {
            return ctx.notes.file;
        },
        storedNotes: () => ctx.notes.notes,
        reconcileSpentOnChain: () => reconcileSpentOnChain(ctx),
        chain: ctx.cfg.chain,
        treeStore: ctx.cfg.treeStore,
        prover: extras.prover.prover,
        submitter: ctx.cfg.submitter,
        selector: ctx.cfg.selector,
        cfg: ctx.cfg,
        leases: ctx.leases,
        markSpent: (ids) => ctx.notes.markSpent(ids),
        markPendingSpend: (ids) => ctx.notes.markPendingSpend(ids),
    };
}
