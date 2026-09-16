// The spend and quote methods of the wallet object: fee quotes, `spendableMax`, transfer, withdraw,
// swap and re-denomination.
//
// Loaded on the first call to any of them, and each loads its operation on demand, so a wallet
// that only quotes fees never downloads the prover, the bundle builders or viem.

import { type AssetId, assetId } from "../../core/brand.js";
import { InvalidArgumentError } from "../../errors/config.js";
import { isWalletError } from "../../errors/guard.js";
import type { WalletApi } from "../api.js";
import type { WalletContext } from "../context.js";
import { filterNotes } from "../notes/read-ops.js";
import type { ConsolidateHost } from "../ops/consolidate.js";
import type { RedenominateHost } from "../ops/redenominate.js";
import type { ConsolidateFirst } from "../selection/index.js";
import type { SpendRun } from "../tx/run-spend.js";
import type { SpendPhase } from "../types/options.js";
import type { SwapResult, TransferResult, WithdrawResult } from "../types/results.js";
import type { WalletApiExtras } from "./api.js";
import { requireObject, runOp, signalOf } from "./op.js";
import { gated } from "./read.js";

/** What the spend methods run on. */
export interface SpendEnv {
    readonly ctx: WalletContext;
    readonly extras: WalletApiExtras;
    /** The wallet's own `awaitCommitments`, so self-spend waits update `state()`. */
    readonly awaitCommitments: WalletApi["awaitCommitments"];
}

/** The methods this module implements, as the wallet object exposes them. */
export type SpendMethods = Pick<
    WalletApi,
    "quoteFee" | "spendableMax" | "transfer" | "withdraw" | "swap" | "quoteSwap" | "redenominate"
>;

export function spendMethods(env: SpendEnv): SpendMethods {
    const { ctx, extras } = env;
    const { state } = extras;

    // Refused before selecting notes, rather than when the proof is requested: an unavailable
    // handle's `warm()` rejects `PROVER_UNAVAILABLE`.
    const requireProver = async () => {
        if (!extras.prover.available) await extras.prover.warm();
    };

    return {
        // A quote is not an operation (`state().ops`), so it runs under the plain read boundary.
        quoteFee: (kind, opts = {}) =>
            gated(
                state,
                "quoteFee",
                async () => {
                    const { quoteFee } = await import("../ops/fee-quote.js");
                    return quoteFee(ctx, kind, { native: opts?.native });
                },
                opts?.signal,
            ),

        spendableMax: (ref, opts = {}) =>
            gated(state, "spendableMax", async () => {
                if (typeof opts !== "object" || opts === null) {
                    throw new InvalidArgumentError("spendableMax: options must be an object", {
                        argument: "opts",
                    });
                }
                const { kind } = opts;
                const [
                    { spendableMax },
                    { selectionRules, withSelection },
                    { resolveSpendFee, estimateKindOf },
                ] = await Promise.all([
                    import("../selection/spendable-max.js"),
                    import("../tx/cover.js"),
                    import("../tx/fee.js"),
                ]);
                const estimateKind =
                    kind === undefined
                        ? undefined
                        : estimateKindOf(kind, "spendableMax", opts.native);
                const selection = selectionRules(opts.selection);
                const asset = await ctx.assets.resolveVerified(ref);
                let maxInputs = ctx.cfg.shape.nIn;
                let fee = 0n;
                // A deposit's fee is paid from the public account, so it reserves nothing here.
                if (estimateKind !== undefined && estimateKind !== "deposit") {
                    // The spend's own fee lookup: a same-asset fee comes out of the maximum, a
                    // cross-asset one takes an input slot.
                    const resolved = await resolveSpendFee(ctx, estimateKind, asset, opts.feeAsset);
                    if (resolved.fee?.crossAsset) maxInputs -= 1;
                    else if (resolved.fee) fee = resolved.fee.value;
                }
                const tipBlock = await ctx.cfg.chain.blockNumber?.();
                return spendableMax(
                    ctx.notes.notes,
                    asset.id,
                    { ...withSelection(selection, maxInputs, tipBlock), fee },
                    ctx.leases,
                );
            }),

        transfer: (args) =>
            runOp<TransferResult, SpendPhase>(state, "transfer", args, async (run) => {
                requireObject(args, "transfer");
                await requireProver();
                const { executeTransfer } = await import("../ops/transfer.js");
                return executeTransfer(ctx, args, run);
            }),

        withdraw: (args) =>
            runOp<WithdrawResult, SpendPhase>(state, "withdraw", args, async (run) => {
                requireObject(args, "withdraw");
                await requireProver();
                const { executeWithdraw } = await import("../ops/withdraw.js");
                return executeWithdraw(ctx, args, run);
            }),

        quoteSwap: (args) =>
            gated(
                state,
                "quoteSwap",
                async () => {
                    requireObject(args, "quoteSwap");
                    const { quoteSwap } = await import("../ops/quote-swap.js");
                    return quoteSwap(ctx, args);
                },
                signalOf(args),
            ),

        swap: (args) =>
            runOp<SwapResult, SpendPhase>(state, "swap", args, async (run) => {
                requireObject(args, "swap");
                await requireProver();
                const { executeSwap } = await import("../ops/swap.js");
                return executeSwap(ctx, args, run);
            }),

        redenominate: (ref, opts = {}) =>
            runOp<number, SpendPhase>(state, "redenominate", opts, async (run) => {
                const { maxRounds } = opts;
                if (maxRounds !== undefined && !(Number.isInteger(maxRounds) && maxRounds > 0)) {
                    throw new InvalidArgumentError(
                        "redenominate: maxRounds must be a positive integer",
                        { argument: "maxRounds" },
                    );
                }
                await requireProver();
                const asset = await ctx.assets.resolveVerified(ref);
                const { redenominate } = await import("../ops/redenominate.js");
                return redenominate(
                    selfSpendHost(ctx, env.awaitCommitments, run),
                    asset,
                    maxRounds !== undefined ? { maxRounds } : {},
                );
            }),
    };
}

/** The slice of a wallet consolidation and re-denomination drive, spending under `run`. */
function selfSpendHost(
    ctx: WalletContext,
    awaitCommitments: WalletApi["awaitCommitments"],
    run: SpendRun,
): ConsolidateHost & RedenominateHost {
    return {
        address: ctx.address,
        maxInputs: ctx.cfg.shape.nIn,
        transfer: async (args) => {
            const { executeTransfer } = await import("../ops/transfer.js");
            return executeTransfer(ctx, args, run);
        },
        awaitCommitments: (cms) => awaitCommitments(cms),
        blockNumber: () => ctx.cfg.chain.blockNumber?.() ?? Promise.resolve(undefined),
        storedNotes: () => ctx.notes.notes,
        notes: (filter) => filterNotes(ctx.notes.notes, filter),
        spendableMax: async (asset, only) => {
            const [{ spendableMax }, { withSelection }, { resolveFee }] = await Promise.all([
                import("../selection/spendable-max.js"),
                import("../tx/cover.js"),
                import("../tx/fee.js"),
            ]);
            const id = assetId(asset);
            // A self-spend names no fee asset, so the relayer is paid in the asset being merged
            // and its fee comes out of the very notes `only` pins.
            const fee = (await resolveFee(ctx, { kind: "transfer", spendAsset: id }))?.value ?? 0n;
            const tipBlock = await ctx.cfg.chain.blockNumber?.();
            // The same rules the self-spend's own cover will apply: pinned ids, the circuit's
            // arity, the tip that dates the cooldown, and the notes in-flight spends hold.
            const { max } = spendableMax(
                ctx.notes.notes,
                id,
                { ...withSelection({ only }, ctx.cfg.shape.nIn, tipBlock), fee },
                ctx.leases,
            );
            return { max, fee };
        },
    };
}

/**
 * `WalletContext.autoConsolidate`: merge the notes `selection` named with a self-spend under the
 * parent spend's `opId`, whose phases are not re-emitted (the parent reports `consolidating`).
 * Errors carry `context.op = "<parent op>:consolidate"`.
 */
export async function consolidateFor(
    ctx: WalletContext,
    awaitCommitments: WalletApi["awaitCommitments"],
    asset: AssetId,
    selection: ConsolidateFirst,
    parent: { readonly opId: string; readonly op: string },
): Promise<void> {
    const run: SpendRun = { opId: parent.opId, op: parent.op, phase: () => undefined };
    const { autoConsolidate } = await import("../ops/consolidate.js");
    try {
        await autoConsolidate(selfSpendHost(ctx, awaitCommitments, run), asset, selection);
    } catch (err) {
        if (isWalletError(err)) {
            const bag = err.context as { op?: string; opId?: string };
            bag.op = `${run.op}:consolidate`;
            bag.opId ??= run.opId;
        }
        throw err;
    }
}
