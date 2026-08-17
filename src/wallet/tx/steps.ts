// Steps every spend shares.
//
// The cover-selection preamble, the change-note split, the submit-and-finalize
// tail, and the deposit-request randomness block, shared by transfer, withdraw
// and swap. Each is parameterised rather than assumed identical: transfer
// computes `ownIndices` from a self-transfer check, while withdraw and swap
// pass `[0, 1]`.

import type { InputSlots } from "../../bundle/common.js";
import type { AssetId, CircuitAmount } from "../../core/brand.js";
import { safePhase } from "../../core/callbacks.js";
import { NetworkError } from "../../core/errors.js";
import type { DecodedAddress } from "../../keys/address.js";
import { decodeAddress } from "../../keys/address.js";
import { getLogger } from "../../log/logger.js";
import type { Note } from "../../notes/note.js";
import {
    freshNoteRandomness,
    freshOutput,
    type NoteOutputRandomness,
} from "../../notes/randomness.js";
import type { OnPhase, SpendPhase } from "../api.js";
import type { SpendContext } from "../context.js";
import { inputsCtx } from "../context.js";
import { ensureCover } from "../cover.js";
import { buildInputSlots } from "../inputs.js";
import type { DirectSelection, SelectOpts } from "../selection.js";

const log = getLogger("lelantos:wallet:spend");

export interface PreparedSpend {
    /** Already narrowed: `ensureCover` resolves the consolidate case. */
    selection: DirectSelection;
    /** Own decoded shielded address — the change recipient. */
    ownAddr: DecodedAddress;
    inputs: InputSlots;
    merkleRoot: bigint;
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
    const selection = await ensureCover(
        ctx.selector,
        () => ctx.storedNotes(),
        {
            asset: args.asset,
            target: args.target,
            // The circuit's arity is the ceiling; a caller may lower it but
            // not raise it past what the proof can consume.
            selectOpts: {
                maxInputs: ctx.cfg.shape.nIn,
                ...(tipBlock !== undefined ? { tipBlock } : {}),
                ...args.selectOpts,
            },
            autoConsolidate: args.autoConsolidate,
        },
        (a, sel) => ctx.autoConsolidate(a, sel),
    );

    const ownAddr = decodeAddress(ctx.J, ctx.address);
    await ctx.treeStore.sync();
    const inputs = await buildInputSlots(inputsCtx(ctx), selection.notes, args.asset);

    return { selection, ownAddr, inputs, merkleRoot: ctx.treeStore.root() };
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
 * Split a change remainder evenly across `slots` output notes.
 *
 * Every slot is used: an unused one would be a zero-value pad, and several
 * roughly equal notes preserve a multi-note cover for the next spend.
 *
 * An indivisible remainder goes to the *last* slots, so at two slots this
 * emits `[floor(r/2), ceil(r/2)]` — the same pair, in the same order, as the
 * two-slot-only version this replaced.
 */
export function splitChange(pk: bigint, asset: bigint, remainder: bigint, slots: number): Note[] {
    if (slots < 1) throw new Error(`splitChange: need at least one slot, got ${slots}`);
    const n = BigInt(slots);
    const base = remainder / n;
    const extra = remainder % n;
    return Array.from({ length: slots }, (_, i) => ({
        asset,
        value: base + (BigInt(i) >= n - extra ? 1n : 0n),
        pk,
        ...freshNoteRandomness(),
    }));
}

/** Fresh randomness for a deposit request's single output slot. */
export function freshDepositSlots(): { output0: NoteOutputRandomness } {
    return { output0: freshOutput() };
}
