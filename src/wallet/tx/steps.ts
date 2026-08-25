// Steps every spend shares.
//
// The cover-selection preamble, the change-note split, the submit-and-finalize
// tail, and the deposit-request randomness block, shared by transfer, withdraw
// and swap. Each is parameterised rather than assumed identical: transfer
// computes `ownIndices` from a self-transfer check, while withdraw and swap
// pass `[0, 1]`.

import type { InputSlots } from "../../bundle/common.js";
import type { AssetId, CircuitAmount } from "../../core/brand.js";
import { branded } from "../../core/brand.js";
import { safePhase } from "../../core/callbacks.js";
import { NetworkError, WireFormatError } from "../../core/errors.js";
import type { DecodedAddress } from "../../keys/address.js";
import { decodeAddress } from "../../keys/address.js";
import { getLogger } from "../../log/logger.js";
import { freshOutput, type NoteOutputRandomness } from "../../notes/randomness.js";
import type { OnPhase, SpendPhase } from "../api.js";
import type { SpendContext } from "../context.js";
import { inputsCtx } from "../context.js";
import { ensureCover } from "../cover.js";
import { buildInputSlots } from "../inputs.js";
import type { DirectSelection, SelectOpts } from "../selection.js";
import type { ResolvedFee } from "./fee.js";

const log = getLogger("lelantos:wallet:spend");

export interface PreparedSpend {
    /** Already narrowed: `ensureCover` resolves the consolidate case. */
    selection: DirectSelection;
    /**
     * Cover for the fee asset, present only when the fee is paid in an asset
     * the spend is not otherwise moving. A same-asset fee is folded into
     * `target` by the caller and comes out of `selection`.
     */
    feeSelection?: DirectSelection;
    /** Own decoded shielded address — the change recipient. */
    ownAddr: DecodedAddress;
    inputs: InputSlots;
    merkleRoot: bigint;
    /** Every note this spend consumes, across both assets. */
    spentIds: string[];
    /**
     * What the spend asset actually had to cover — the caller's `target` plus a
     * same-asset fee. Change is `selection.sum - covered`.
     */
    covered: CircuitAmount;
}

/**
 * Select cover, sync the tree, and build the input slots.
 *
 * `target` is the full amount that must be covered, fee included — the
 * caller computes it, because each flow derives it differently.
 */
export async function prepareSpend(
    ctx: SpendContext,
    args: {
        asset: AssetId;
        target: CircuitAmount;
        /**
         * The relayer's fee, if it charges one.
         *
         * Handled here rather than by each caller because the two cases pull in
         * opposite directions and every flow got them subtly differently: a
         * same-asset fee raises the target the spend must cover, while a
         * cross-asset one leaves the target alone and takes cover of its own.
         */
        fee?: ResolvedFee | null | undefined;
        selectOpts?: SelectOpts | undefined;
        autoConsolidate?: boolean | undefined;
        onPhase?: OnPhase<SpendPhase> | undefined;
    },
): Promise<PreparedSpend> {
    safePhase(args.onPhase, "preparing");
    // The selector's spend cooldown needs a tip; without one a note is
    // spendable in the block it arrived in, linking a change note to the spend
    // that produced it.
    const tipBlock = await ctx.cfg.chain.blockNumber?.();
    const nIn = ctx.cfg.shape.nIn;
    const cover = (asset: AssetId, target: CircuitAmount, maxInputs: number) =>
        ensureCover(
            ctx.selector,
            () => ctx.storedNotes(),
            {
                asset,
                target,
                // The circuit's arity is the ceiling; a caller may lower it but
                // not raise it past what the proof can consume.
                selectOpts: {
                    maxInputs,
                    ...(tipBlock !== undefined ? { tipBlock } : {}),
                    ...args.selectOpts,
                },
                autoConsolidate: args.autoConsolidate,
            },
            (a, sel) => ctx.autoConsolidate(a, sel),
        );

    // A same-asset fee comes out of the same notes as the spend, so it has to
    // be covered alongside it.
    const feeCover = args.fee?.cover;
    const covered = branded<CircuitAmount>(
        args.target + (args.fee && !args.fee.crossAsset ? args.fee.value : 0n),
    );

    // A cross-asset fee needs at least one input slot of its own, so the spend
    // cannot be allowed to fill every slot first and leave the fee unpayable.
    // Reserving one up front turns "no slot left for the fee" into an ordinary
    // insufficient-cover error against the asset being moved, which is both
    // actionable and what the caller can do something about.
    const selection = await cover(args.asset, covered, feeCover ? nIn - 1 : nIn);

    let feeSelection: DirectSelection | undefined;
    if (feeCover) {
        const remaining = nIn - selection.notes.length;
        if (remaining < 1) {
            throw new Error(
                `spend needs ${selection.notes.length} of ${nIn} input slots for asset ` +
                    `${args.asset}, leaving none for a fee in asset ${feeCover.asset}; ` +
                    "consolidate that asset or pay the fee in the asset being moved",
            );
        }
        feeSelection = await cover(feeCover.asset, feeCover.value, remaining);
    }

    const notes = [...selection.notes, ...(feeSelection?.notes ?? [])];
    const ownAddr = decodeAddress(ctx.J, ctx.address);
    await syncTreeToVerifiedRoot(ctx);
    const inputs = await buildInputSlots(inputsCtx(ctx), notes);

    return {
        selection,
        ...(feeSelection ? { feeSelection } : {}),
        ownAddr,
        inputs,
        merkleRoot: ctx.treeStore.root(),
        spentIds: notes.map((n) => n.id),
        covered,
    };
}

/**
 * Sync the tree and confirm the root it built is one the chain holds.
 *
 * The wallet no longer derives leaves from primary data — it trusts the
 * server's `leafHash` — so a wrong or lagging value yields a wrong root with
 * no local symptom. Proving against it costs a full Groth16 run (seconds to a
 * minute) and then fails `isKnownRoot` as an unexplained relayer rejection.
 * `verifyRoot` is the check that catches it, and until now nothing called it.
 *
 * One retry, because a mismatch is usually benign: the mirror lags the chain,
 * so a tree synced mid-block legitimately disagrees for a moment. A second
 * disagreement is not a race, so it is reported rather than proved against.
 */
async function syncTreeToVerifiedRoot(ctx: SpendContext): Promise<void> {
    await ctx.treeStore.sync();
    if (await ctx.treeStore.verifyRoot()) return;

    log.debug("local tree root disagrees with the chain; resyncing once");
    await ctx.treeStore.sync();
    if (await ctx.treeStore.verifyRoot()) return;

    throw new WireFormatError(
        "$.root",
        "local Merkle root does not match the chain after resyncing — the commitment " +
            "feed is serving leaves that do not reconcile, so any proof built against " +
            "this tree would be rejected on chain",
        { context: { root: ctx.treeStore.root().toString() } },
    );
}

/**
 * The relayer's own words for a broadcast it never saw confirmed —
 * `AppError::SubmitUnknown` in `crates/relayer/src/domain/error.rs`. It shares
 * a 502 with a plain revert, which is a definite no, so the body is what tells
 * the two apart.
 */
const SUBMIT_UNKNOWN_BODY = "outcome unknown";

/**
 * Whether a failed submit leaves it unknown whether the spend was accepted.
 *
 * The distinction decides what happens to the notes. A rejection the relayer
 * articulated — a bad payload, a stale root — means nothing was spent and the
 * notes stay available. A submit that never came back with an answer may have
 * landed anyway, and offering those notes again is how a wallet ends up
 * spending into a duplicate rejection over and over.
 *
 *   - no status: a timeout or a dropped connection, so the request may have
 *     been received and acted on.
 *   - 409: the relayer holds these nullifiers as spent or in flight. Whichever
 *     it is, they are not ours to spend again right now.
 *   - 502 naming an unknown outcome: broadcast succeeded, no receipt arrived.
 *
 * @internal — exported to be tested directly; the policy is the whole point.
 */
export function outcomeUnknown(err: unknown): boolean {
    if (!(err instanceof NetworkError)) return false;
    if (err.status === undefined || err.status === 409) return true;
    return err.status === 502 && (err.body?.includes(SUBMIT_UNKNOWN_BODY) ?? false);
}

/**
 * Submit a spend and record what it did to the notes it consumed.
 *
 * On success they are spent. On a failure that settles the question they are
 * untouched. Otherwise they are reserved: withheld from the selector until the
 * nullifier feed says whether they were spent, or until the reservation
 * expires. See `StoredNote.pendingSpendAt`.
 */
export async function submitSpend<T>(
    ctx: Pick<SpendContext, "markSpent" | "markPendingSpend">,
    spent: string[],
    submit: () => Promise<T>,
): Promise<T> {
    let result: T;
    try {
        result = await submit();
    } catch (err) {
        if (!outcomeUnknown(err)) throw err;
        // The one branch that leaves the wallet's view of these notes
        // unresolved, and the reason a balance can drop without a matching
        // transaction. Logged so that is answerable after the fact.
        log.warn("spend outcome unknown; reserving its notes", {
            notes: spent.length,
            error: err instanceof Error ? err.message : String(err),
        });
        await ctx.markPendingSpend(spent);
        throw err;
    }
    await ctx.markSpent(spent);
    return result;
}

/**
 * Fresh randomness for a deposit's two output slots.
 *
 * A deposit mints the depositor's note and the relayer's fee note, and each
 * needs its own blinders — sharing them would let anyone who can open one leaf
 * open the other.
 */
export function freshDepositSlots(): {
    output0: NoteOutputRandomness;
    fee: NoteOutputRandomness;
} {
    return { output0: freshOutput(), fee: freshOutput() };
}
