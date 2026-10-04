// Spend bundle builder: proves the transact circuit for every spend kind.
//
// Transfer, withdraw and withdrawNative share one skeleton; a transfer is the withdraw shape
// with `publicOut = 0`. `kind` sets `SubmitTransactPayload.kind`, which routes the on-chain call.

import { assertU64 } from "../core/field.js";
import { buildNoteCommitment, type Field } from "../crypto/index.js";
import { assertInvariant } from "../errors/base.js";
import { InvalidArgumentError } from "../errors/config.js";
import type { Note } from "../notes/note.js";
import { deriveOutputEsk } from "../notes/outgoing.js";
import { shapeId } from "../protocol/shape.js";
import type { SpendKind } from "../protocol/transact.js";
import {
    type BuiltBundle,
    type BundleCommon,
    buildAuxForReal,
    buildInputs,
    deriveOutputRho,
    finalize,
    type InputSlots,
    type OutputRandomness,
    type OutputRecipient,
} from "./common.js";

export interface SpendArgs extends BundleCommon {
    /** Which on-chain entry point the relayer should call. */
    kind: SpendKind;
    inputs: InputSlots;
    merkleRoot: Field;
    /**
     * One note per output slot: the send note of a transfer, the relayer's fee note, change back
     * to self, and zero-value pads. Per asset, they must sum to the real input value, less
     * `publicOut` for `asset`.
     */
    outputs: readonly Note[];
    /**
     * Recipient address per output slot, used for the FMD clue and ECDH. Change slots take
     * the sender's own address. A pad takes keys drawn for it, never the sender's: a clue for
     * the sender's key on every unused slot would mark the spend as the sender's to a detector.
     */
    outputRecipients: readonly OutputRecipient[];
    outputRandomness: readonly OutputRandomness[];
    /** Value leaving the shielded pool. 0 for a transfer. */
    publicOut?: bigint;
    /**
     * The sender's outgoing cipher key (`deriveOutgoingKey`). When set, every output's ECDH
     * ephemeral is derived from it and the output itself, replacing `outputRandomness[i].esk`,
     * so the sender can later recompute it and prove what the output paid. Omitted: the drawn
     * `esk` is used.
     */
    outgoingKey?: Uint8Array | undefined;
}

export async function buildSpend(a: SpendArgs): Promise<BuiltBundle> {
    const { P, J, kind } = a;
    const publicOut = a.publicOut ?? 0n;

    if (a.inputs.every((s) => s == null)) {
        throw new InvalidArgumentError(`${kind}: at least one real input required`, {
            argument: "inputs",
        });
    }
    if (
        a.outputs.length !== a.outputRecipients.length ||
        a.outputs.length !== a.outputRandomness.length
    ) {
        throw new InvalidArgumentError(
            `${kind}: outputs, outputRecipients and outputRandomness must be the same length ` +
                `(got ${a.outputs.length}, ${a.outputRecipients.length}, ${a.outputRandomness.length})`,
            { argument: "outputs" },
        );
    }

    assertBalance(a, publicOut);
    assertProvable(a, publicOut);

    const realIns = buildInputs(P, a.inputs, a.treeDepth);
    const firstNullifier = realIns[0]?.nf;
    assertInvariant(firstNullifier !== undefined, `${kind}: no input slots`);

    const outputs = deriveOutputRho(P, firstNullifier, a.outputs);
    const aux = outputs.map((note, i) =>
        buildAuxForReal(J, P, note, a.outputRecipients[i]!, outputRng(a, note, i)),
    );

    return finalize(a, kind, realIns, outputs, a.merkleRoot, publicOut, aux);
}

/**
 * Slot `i`'s aux randomness: as supplied, with `esk` replaced by the derived one when the
 * sender's outgoing key is known. `note` must already carry its final `rho`, since the
 * derivation binds the commitment.
 */
function outputRng(a: SpendArgs, note: Note, i: number): OutputRandomness {
    const rng = a.outputRandomness[i]!;
    if (a.outgoingKey === undefined) return rng;
    const cm = buildNoteCommitment(a.P, note);
    return { ...rng, esk: deriveOutputEsk(a.outgoingKey, a.chainId, cm) };
}

/** Quaternary Merkle tree: one slot for the node, three siblings per level. */
const MERKLE_ARITY = 4;

/**
 * Reject a spend the circuit cannot satisfy, before any artifact is fetched. Each mistake
 * would otherwise survive witness construction and fail inside the prover, as an opaque circom
 * assertion or as a valid-looking proof against the wrong root that only the chain rejects.
 */
function assertProvable(a: SpendArgs, publicOut: bigint): void {
    assertArity(a);
    assertU64(publicOut, `${a.kind}: publicOut`);
    for (const [i, slot] of a.inputs.entries()) assertInputSlot(a, slot, i);
    for (const [i, note] of a.outputs.entries()) {
        assertU64(note.value, `${a.kind}: output slot ${i} value`);
        assertAssetId(note.asset, `${a.kind}: output slot ${i} asset`);
    }
}

/**
 * A note's asset id: a non-zero u64. Id 0 means "no asset"; `OutputNote` and a real
 * `SpentNote` both refuse it, zero-value pads included.
 */
function assertAssetId(asset: bigint, label: string): void {
    assertU64(asset, label);
    if (asset === 0n) {
        throw new InvalidArgumentError(`${label} must not be 0`, { argument: "asset" });
    }
}

/** Slot counts against the shape the caller named; see {@link BundleCommon.shape}. */
function assertArity({ kind, shape, inputs, outputs }: SpendArgs): void {
    if (!shape) return;
    const name = shapeId(shape);
    if (inputs.length !== shape.nIn) {
        throw new InvalidArgumentError(
            `${kind}: ${inputs.length} input slots for a ${name} circuit; ` +
                "pad unused slots with null",
            { argument: "inputs" },
        );
    }
    if (outputs.length !== shape.nOut) {
        throw new InvalidArgumentError(
            `${kind}: ${outputs.length} output slots for a ${name} circuit; ` +
                "pad unused slots with zero-value notes",
            { argument: "outputs" },
        );
    }
}

/** A real input slot. `null` is a dummy, constrained by `is_dummy` instead. */
function assertInputSlot(a: SpendArgs, slot: InputSlots[number], i: number): void {
    if (!slot) return;
    const { note } = slot.cached;
    assertU64(note.value, `${a.kind}: input slot ${i} value`);
    assertAssetId(note.asset, `${a.kind}: input slot ${i} asset`);
    assertPathShape(a.kind, i, a.treeDepth, slot.pathElements, slot.pathIndices);
}

function tally(into: Map<bigint, bigint>, asset: bigint, value: bigint): void {
    into.set(asset, (into.get(asset) ?? 0n) + value);
}

/**
 * Value conservation, per asset. Mirrors `PerAssetValueBalance` in
 * `circuits/src/lib/balance.circom`, which requires
 *
 *     Σ in[asset]  ==  Σ out[asset] + public_out[asset]
 *
 * independently for every asset present, so one spend can carry a second asset paying the
 * relayer's fee. A single sum across every slot is not equivalent: it accepts a spend that
 * mints one asset and burns another in equal measure.
 *
 * `publicOut` counts against {@link SpendArgs.asset} alone: the transparent bucket is one
 * `public_asset_id` signal in the circuit, so it belongs to exactly one asset. With
 * `publicOut == 0` the bucket is empty and the proof names no asset.
 */
function assertBalance(a: SpendArgs, publicOut: bigint): void {
    const ins = new Map<bigint, bigint>();
    const outs = new Map<bigint, bigint>();

    for (const slot of a.inputs) {
        if (slot) tally(ins, slot.cached.note.asset, slot.cached.note.value);
    }
    for (const note of a.outputs) tally(outs, note.asset, note.value);
    tally(outs, a.asset, publicOut);

    for (const asset of new Set([...ins.keys(), ...outs.keys()])) {
        const inSum = ins.get(asset) ?? 0n;
        const outSum = outs.get(asset) ?? 0n;
        if (inSum === outSum) continue;
        // Amounts stay out of the message, which reaches application logs; the asset, the
        // direction and whether `publicOut` is involved are enough to tell a withdraw short by
        // the fee from one with wrong change.
        const bucket = asset === a.asset ? " (including publicOut)" : "";
        throw new InvalidArgumentError(
            `${a.kind} balance for asset ${asset}: ` +
                `${inSum > outSum ? "inputs exceed outputs" : "outputs exceed inputs"}${bucket}`,
            { argument: "outputs" },
        );
    }
}

/**
 * A path of the wrong shape still builds a witness, but proves against a root that is not the
 * tree's; for example a binary-shaped path (one sibling per level, indices 0/1).
 */
function assertPathShape(
    kind: string,
    slot: number,
    treeDepth: number,
    pathElements: readonly (readonly bigint[])[],
    pathIndices: readonly number[],
): void {
    if (pathElements.length !== treeDepth || pathIndices.length !== treeDepth) {
        throw new InvalidArgumentError(
            `${kind}: input slot ${slot} has a ${pathElements.length}-level path ` +
                `(${pathIndices.length} indices) for a depth-${treeDepth} tree`,
            { argument: "inputs" },
        );
    }
    for (let lvl = 0; lvl < treeDepth; lvl++) {
        const sibs = pathElements[lvl]!;
        if (sibs.length !== MERKLE_ARITY - 1) {
            throw new InvalidArgumentError(
                `${kind}: input slot ${slot} level ${lvl} has ${sibs.length} siblings, ` +
                    `expected ${MERKLE_ARITY - 1}`,
                { argument: "inputs" },
            );
        }
        const idx = pathIndices[lvl]!;
        if (!Number.isInteger(idx) || idx < 0 || idx >= MERKLE_ARITY) {
            throw new InvalidArgumentError(
                `${kind}: input slot ${slot} level ${lvl} has index ${idx}, ` +
                    `expected 0..${MERKLE_ARITY - 1}`,
                { argument: "inputs" },
            );
        }
    }
}
