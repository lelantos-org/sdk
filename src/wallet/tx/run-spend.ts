// The pipeline every shielded spend runs: transfer, withdraw and swap differ only in the spec
// they hand it.
//
//   spec.plan      validate arguments, resolve assets and amounts          → phase "preparing"
//   fee            resolve the relayer's fee (and its asset)
//   cover          select and lease notes, consolidating if allowed        (→ "consolidating")
//   witness        sync and verify the tree, read root and paths atomically
//   outputs        spec.outputs (payee) + change + fee slots, shuffled
//   spec.bind      the proof's public bindings, and any pre-proof work
//   prove                                                                  → phase "proving"
//   deadline       refuse to submit at or past the cut-off (DEADLINE_PASSED)
//   submit         classify a failure and settle the notes                 → phase "submitting"
//   answer         the relayer answers once mined                          → phase "confirmed"
//   spec.result    the receipt, located in its transaction
//
// The caller's `signal` is checked between every step and rejects with its own reason. From the
// moment cover is leased, every exit releases the lease: after the notes are marked spent or
// reserved on submit, or untouched on any earlier failure.

import type { BuiltBundle, InputSlots } from "../../bundle/common.js";
import { buildSpend } from "../../bundle/spend.js";
import type { AssetId, CircuitAmount, Hex32 } from "../../core/brand.js";
import { branded } from "../../core/brand.js";
import { randomHex } from "../../core/random.js";
import { InsufficientCoverError } from "../../errors/funds.js";
import { TreeOutOfSyncError } from "../../errors/network.js";
import { type DecodedAddress, decodeAddress } from "../../keys/address.js";
import type { RelayerSubmitResponse } from "../../protocol/responses.js";
import type { SpendKind } from "../../protocol/transact.js";
import type { EstimateKind } from "../../services/relayer/submitter.js";
import type { AssetInfo } from "../assets/info.js";
import type { WalletContext } from "../context.js";
import type { StoredNote } from "../notes/note-store.js";
import { resyncSpent } from "../notes/sync-ops.js";
import type { DirectSelection } from "../selection/index.js";
import type { OpRun, SelectionOptions, SpendOptions, SpendPhase } from "../types/options.js";
import type { Money } from "../types/results.js";
import { ensureCover, selectionRules, withSelection } from "./cover.js";
import { assertBeforeDeadline, checkDeadlineArg } from "./deadline.js";
import { feeSlots, type ResolvedFee, relayerMoney, resolveSpendFee } from "./fee.js";
import { buildInputSlots } from "./inputs.js";
import { changeSlots, finalizeSlots, type OutputSlotSpec } from "./outputs.js";
import { type OutputCommitments, outputCommitments } from "./result-builder.js";
import { submitSpend, withOperation } from "./steps.js";

/** A spend's run, as the wallet object's `runOp` provides it. */
export type SpendRun = OpRun<SpendPhase>;

/** A spend's options; `onPhase` and `opId` reach it through the {@link SpendRun}. */
type SpendRunOptions = Omit<SpendOptions, "onPhase" | "opId">;

/** A run with a fresh id that reports nowhere, for a spend driven outside the wallet object. */
export function detachedRun(op: string): SpendRun {
    return { opId: randomHex(8), op, phase: () => undefined };
}

/** What a spend moves, once its arguments are validated and resolved. */
interface SpendPlan {
    /** The relayer estimate the fee is quoted under. */
    readonly feeKind: EstimateKind;
    /** The asset the spend draws from its notes; change is split onto its ladder. */
    readonly asset: AssetInfo;
    /** Value to cover from `asset`, excluding a same-asset relayer fee. */
    readonly target: CircuitAmount;
}

/** A spend whose notes are leased and witnessed, handed to {@link SpendSpec.bind}. */
interface CoveredSpend {
    readonly fee: ResolvedFee | null;
    readonly selection: DirectSelection;
    /** Change left in the spend asset: `selection.sum - target - same-asset fee`. */
    readonly change: CircuitAmount;
}

/** The proof's public bindings, and how the proven bundle reaches the relayer. */
export interface SpendBinding {
    /** The pool entry point the relayer calls. */
    kind: SpendKind;
    payer: string;
    relayer: string;
    recipient: string;
    /** Value leaving the pool. Absent for a transfer. */
    publicOut?: bigint;
    /** A swap's intent hash; zero for every other spend. */
    intentHash?: bigint;
    /** Defaults to `cfg.submitter.submit(built.payload)`. */
    submit?: ((built: BuiltBundle) => Promise<RelayerSubmitResponse>) | undefined;
    /** Submit cut-off when the binding fixes one (a swap's intent deadline); else the caller's. */
    deadline?: bigint | undefined;
}

/** A spend the relayer accepted, handed to {@link SpendSpec.result}. */
interface LandedSpend extends Omit<OutputCommitments, "ownInflow"> {
    opId: string;
    txHash: Hex32;
    built: BuiltBundle;
    spent: string[];
    change: CircuitAmount;
    /** The transfer payee's commitment. */
    payeeCommitment?: Hex32 | undefined;
    /** The fee note actually built, in the asset that paid it; `null` when none was charged. */
    relayerFee: Money | null;
}

/** The leading `ResultBase` fields every spend result copies from its landed spend. */
export function landedBase(landed: LandedSpend, asset: AssetInfo) {
    const { opId, txHash, commitments, ownCommitments, nonZeroCommitments } = landed;
    return { opId, asset, txHash, commitments, ownCommitments, nonZeroCommitments };
}

/** What a spend result must carry for `withOperation` to locate it. */
interface SpendResult {
    txHash: Hex32;
    commitments: Hex32[];
}

/** What distinguishes one kind of spend. See the file header for when each hook runs. */
interface SpendSpec<P extends SpendPlan, R extends SpendResult> {
    readonly options: SpendRunOptions;
    /** Validate and resolve arguments. Nothing is quoted or selected before this returns. */
    plan(ctx: WalletContext): Promise<P>;
    /** Output slots other than change and fee (a transfer's payee). */
    outputs?(ctx: WalletContext, plan: P): OutputSlotSpec[];
    /** The proof's bindings, once cover is held; may do pre-proof work such as a swap's escrows. */
    bind(ctx: WalletContext, plan: P, cover: CoveredSpend): SpendBinding | Promise<SpendBinding>;
    result(ctx: WalletContext, plan: P, landed: LandedSpend): R;
}

export async function runSpend<P extends SpendPlan, R extends SpendResult>(
    ctx: WalletContext,
    spec: SpendSpec<P, R>,
    run: SpendRun,
): Promise<R> {
    const opts = spec.options;
    const signal = opts.signal;
    const deadline = checkDeadlineArg(opts.deadline);
    const selection = selectionRules(opts.selection);
    signal?.throwIfAborted();
    run.phase("preparing");
    const plan = await spec.plan(ctx);
    assertBeforeDeadline(deadline);
    const { feeAsset, fee } = await resolveSpendFee(ctx, plan.feeKind, plan.asset, opts.feeAsset);
    signal?.throwIfAborted();

    const cover = await coverAndWitness(ctx, plan, fee, { rules: selection, opts, run });
    try {
        signal?.throwIfAborted();
        const {
            selection: picked,
            feeSelection,
            ownAddr,
            inputs,
            merkleRoot,
            spentIds,
            covered,
        } = cover;
        const change = branded<CircuitAmount>(picked.sum - covered);
        const { pk } = ctx.keys;
        const extra = spec.outputs?.(ctx, plan) ?? [];
        // Roles are carried on the slots, not positions, because `finalizeSlots` shuffles them;
        // see `outputs.ts`. Change is split onto the ladder so it can be withdrawn later.
        const slots = finalizeSlots([
            ...extra,
            ...changeSlots({
                pk,
                ownAddr,
                asset: plan.asset.id,
                remainder: change,
                slots: ctx.cfg.shape.nOut - extra.length - (fee?.slots ?? 0),
                ladder: plan.asset.ladder,
            }),
            ...feeSlots(fee, feeSelection, pk, ownAddr),
        ]);
        const binding = await spec.bind(ctx, plan, { fee, selection: picked, change });
        signal?.throwIfAborted();

        run.phase("proving");
        const built = await buildSpend({
            kind: binding.kind,
            P: ctx.P,
            J: ctx.J,
            chainId: ctx.cfg.chainId,
            asset: plan.asset.id,
            payerAddress: binding.payer,
            relayerAddress: binding.relayer,
            recipientAddress: binding.recipient,
            ...(binding.intentHash !== undefined ? { intentHash: binding.intentHash } : {}),
            prover: ctx.cfg.prover,
            treeDepth: ctx.cfg.treeDepth,
            shape: ctx.cfg.shape,
            inputs,
            merkleRoot,
            ...(binding.publicOut !== undefined ? { publicOut: binding.publicOut } : {}),
            ...slots.args,
        });
        // Last moment to back out: once handed to the relayer, the spend cannot be recalled.
        signal?.throwIfAborted();
        assertBeforeDeadline(binding.deadline ?? deadline);

        run.phase("submitting");
        const submit = binding.submit ?? ((b) => ctx.cfg.submitter.submit(b.payload));
        const settlement = {
            markSpent: (ids: string[]) => ctx.notes.markSpent(ids),
            markPendingSpend: (ids: string[]) => ctx.notes.markPendingSpend(ids),
            resyncSpent: () => resyncSpent(ctx),
        };
        const { txHash } = await submitSpend(settlement, spentIds, () => submit(built));
        run.phase("confirmed", txHash);

        const { ownInflow: _, ...commitments } = outputCommitments(built, slots.ownIndices);
        const landed: LandedSpend = {
            opId: run.opId,
            txHash,
            built,
            spent: spentIds,
            change,
            ...commitments,
            ...(slots.payeeIndex !== undefined
                ? { payeeCommitment: commitments.commitments[slots.payeeIndex] }
                : {}),
            relayerFee: relayerMoney(feeAsset, fee),
        };
        return Object.freeze(await withOperation(ctx.cfg.chain, spec.result(ctx, plan, landed)));
    } finally {
        ctx.leases.release(cover.spentIds);
    }
}

/** Leased cover for a spend, with its inputs witnessed against one verified root. */
interface Witnessed {
    selection: DirectSelection;
    /**
     * Cover for the fee asset, present only when the fee is paid in an asset the spend is not
     * otherwise moving. A same-asset fee is part of `covered` and comes out of `selection`.
     */
    feeSelection?: DirectSelection;
    /** Own decoded shielded address, the change recipient. */
    ownAddr: DecodedAddress;
    inputs: InputSlots;
    merkleRoot: bigint;
    /** Every note this spend consumes, across both assets. */
    spentIds: string[];
    /** The plan's `target` plus a same-asset fee. Change is `selection.sum - covered`. */
    covered: CircuitAmount;
}

/**
 * Select and lease cover, then witness the inputs.
 *
 * Each cover comes back leased (see `leases.ts`). Until this returns, a failure releases them;
 * after it returns, `runSpend` owns the lease.
 */
async function coverAndWitness(
    ctx: WalletContext,
    plan: SpendPlan,
    fee: ResolvedFee | null,
    {
        rules,
        opts,
        run,
    }: { rules: SelectionOptions | undefined; opts: SpendRunOptions; run: SpendRun },
): Promise<Witnessed> {
    const nIn = ctx.cfg.shape.nIn;
    const cover = (asset: AssetId, target: CircuitAmount, maxInputs: number) =>
        ensureCover(
            ctx.cfg.selector,
            () => ctx.notes.notes,
            {
                asset,
                target,
                // Rebuilt per attempt, so the cooldown sees a tip read after any consolidation;
                // see `cover.ts`.
                selectOpts: async () => {
                    const tipBlock = await ctx.cfg.chain.blockNumber?.();
                    // The circuit's arity is the ceiling; a caller may lower it but not raise it
                    // past what the proof can consume.
                    return withSelection(rules, maxInputs, tipBlock);
                },
                autoConsolidate: opts.autoConsolidate,
            },
            async (asset, sel) => {
                // The nested self-spend's own phases are not re-emitted; it runs under this opId.
                run.phase("consolidating");
                await ctx.autoConsolidate(asset, sel, run);
                opts.signal?.throwIfAborted();
                run.phase("preparing");
            },
            ctx.leases,
        );

    // A same-asset fee comes out of the same notes as the spend, so it is covered alongside it.
    const covered = branded<CircuitAmount>(plan.target + (fee && !fee.crossAsset ? fee.value : 0n));
    // A cross-asset fee needs at least one input slot. Reserving it up front turns "no slot left
    // for the fee" into an ordinary insufficient-cover error against the asset being moved.
    const feeCover = fee?.cover;
    const selection = await cover(plan.asset.id, covered, feeCover ? nIn - 1 : nIn);
    const held = [...selection.notes];
    try {
        let feeSelection: DirectSelection | undefined;
        if (feeCover) {
            const remaining = nIn - selection.notes.length;
            if (remaining < 1) {
                // A cover failure of the spend asset: merging its notes frees a slot.
                throw new InsufficientCoverError({
                    asset: plan.asset.id,
                    target: covered,
                    reason: "fee-slot",
                    consolidate: selection.notes.map((n) => ({ id: n.id, value: n.value })),
                    consolidateSum: selection.sum,
                });
            }
            feeSelection = await cover(feeCover.asset, feeCover.value, remaining);
            held.push(...feeSelection.notes);
        }

        const ownAddr = decodeAddress(ctx.J, ctx.address);
        const { merkleRoot, inputs } = await witnessAgainstVerifiedRoot(ctx, held);
        return {
            selection,
            ...(feeSelection ? { feeSelection } : {}),
            ownAddr,
            inputs,
            merkleRoot,
            spentIds: held.map((n) => n.id),
            covered,
        };
    } catch (err) {
        ctx.leases.release(held.map((n) => n.id));
        throw err;
    }
}

/**
 * Sync the tree and confirm it is one the pool would accept a proof against.
 *
 * The wallet trusts the server's `leafHash` rather than deriving leaves from primary data, so a
 * wrong or lagging value yields a wrong root with no local symptom. Proving against it costs a full
 * Groth16 run and then fails `isKnownRoot` at the relayer.
 *
 * `TreeStore.syncVerifiedSnapshot` handles reconciliation, repairs and when to query the chain; it
 * receives the adapter's `isKnownRoot` because it has no other access to the pool. The spend path
 * only refuses.
 */
async function witnessAgainstVerifiedRoot(
    ctx: WalletContext,
    notes: StoredNote[],
): Promise<{ merkleRoot: bigint; inputs: InputSlots }> {
    const { chain, treeStore } = ctx.cfg;
    // The root and every input path are read under the tree's lock, in the same critical section
    // as the verification: a concurrent sync or reset between them would pair a root with paths
    // from another tree.
    const { check, value } = await treeStore.syncVerifiedSnapshot(
        // Bound: passed as a value, and the adapter's reads go through `this`.
        { isKnownRoot: chain.isKnownRoot?.bind(chain) },
        async () => {
            const merkleRoot = treeStore.root();
            const inputs = await buildInputSlots(
                {
                    pk: ctx.keys.pk,
                    nsk: ctx.keys.nsk,
                    treeStore,
                    nIn: ctx.cfg.shape.nIn,
                    expectedRoot: merkleRoot,
                },
                notes,
            );
            return { merkleRoot, inputs };
        },
    );
    if (check.spendable && value) return value;

    throw new TreeOutOfSyncError(
        { localRoot: check.localRoot, mirrorRoot: check.mirrorRoot },
        { details: { localLeaves: check.localLeaves, mirrorLeaves: check.mirrorLeaves } },
    );
}
