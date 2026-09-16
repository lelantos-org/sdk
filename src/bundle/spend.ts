// Spend bundle builder: proves the transact circuit for every spend kind.
//
// Transfer, withdraw and withdrawNative share one skeleton; a transfer is the
// withdraw shape with `publicOut = 0`.
//
// `kind` flows into `SubmitTransactPayload.kind`, which routes the on-chain
// call, so it is a required argument here rather than something a wrapper
// supplies. `spend.test.ts` asserts each kind end to end.

import { assertU64 } from "../core/field.js";
import type { Field } from "../crypto/index.js";
import { assertInvariant } from "../errors/base.js";
import { InvalidArgumentError } from "../errors/config.js";
import type { Note } from "../notes/note.js";
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
     * One note per output slot. For a transfer these are the send note and
     * the change notes; for a withdraw all are change back to self. Together
     * they must sum to `total real input value − publicOut`.
     */
    outputs: readonly Note[];
    /**
     * Recipient address per output slot (drives the FMD clue + ECDH).
     * Change slots take the sender's own address.
     */
    outputRecipients: readonly OutputRecipient[];
    outputRandomness: readonly OutputRandomness[];
    /** Value leaving the shielded pool. 0 for a transfer. */
    publicOut?: bigint;
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
        buildAuxForReal(J, P, note, a.outputRecipients[i]!, a.outputRandomness[i]!),
    );

    return finalize(a, kind, realIns, outputs, a.merkleRoot, 0n, publicOut, aux);
}

/** Quaternary Merkle tree — one slot for the node, three siblings per level. */
const MERKLE_ARITY = 4;

/**
 * Reject a spend the circuit cannot satisfy, before any artifact is fetched.
 *
 * These checks are cheap and local. Each mistake would otherwise survive witness
 * construction and fail seconds to a minute later inside the prover, either as
 * an opaque circom assertion or as a valid-looking proof against the wrong root
 * that only the chain rejects.
 */
function assertProvable(a: SpendArgs, publicOut: bigint): void {
    assertArity(a);
    assertU64(publicOut, `${a.kind}: publicOut`);
    for (const [i, slot] of a.inputs.entries()) assertInputSlot(a, slot, i);
    for (const [i, note] of a.outputs.entries()) {
        assertU64(note.value, `${a.kind}: output slot ${i} value`);
    }
}

/**
 * Slot counts against the shape the caller named.
 *
 * Optional because `toCircomInput` infers the shape from the array lengths, which
 * also hides a mismatch: a spend with the wrong output count for the key builds a valid
 * witness with the wrong number of public inputs and fails inside the prover.
 */
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
    assertPathShape(a.kind, i, a.treeDepth, slot.pathElements, slot.pathIndices);
}

/** Running total per asset id. */
function tally(into: Map<bigint, bigint>, asset: bigint, value: bigint): void {
    into.set(asset, (into.get(asset) ?? 0n) + value);
}

/**
 * Value conservation, checked per asset.
 *
 * Mirrors `PerAssetValueBalance` in `circuits/src/lib/balance.circom`. The
 * circuit places no constraint linking one slot's asset to another's, and
 * instead requires
 *
 *     Σ in[asset] + public_in[asset]  ==  Σ out[asset] + public_out[asset]
 *
 * independently for every asset present. This lets one spend carry the asset
 * being moved alongside a second asset paying the relayer's fee.
 *
 * A single sum across every slot is not equivalent: it accepts a spend that
 * mints one asset and burns another in equal measure, the forgery
 * `PerAssetValueBalance` exists to reject.
 *
 * `publicOut` counts against {@link SpendArgs.asset} alone: the transparent
 * bucket is one `public_asset_id` signal in the circuit, so it belongs to
 * exactly one asset no matter how many the shielded slots carry.
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
        // Amounts stay out of the message, which reaches application logs; the
        // asset, the direction and whether `publicOut` is involved are enough to
        // tell a withdraw short by the fee from one with wrong change.
        const bucket = asset === a.asset ? " (including publicOut)" : "";
        throw new InvalidArgumentError(
            `${a.kind} balance for asset ${asset}: ` +
                `${inSum > outSum ? "inputs exceed outputs" : "outputs exceed inputs"}${bucket}`,
            { argument: "outputs" },
        );
    }
}

/**
 * A path of the wrong shape still builds a witness, but proves against a root
 * that is not the tree's; for example, a binary-shaped path (one sibling per
 * level, indices 0/1) from a mis-implemented relayer.
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
