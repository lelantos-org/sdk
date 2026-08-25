// Spend bundle builder — proves the transact circuit for every spend kind.
//
// `buildTransfer`, `buildWithdraw` and `buildWithdrawNative` share one
// six-step skeleton; transfer is the withdraw shape with `publicOut = 0`.
//
// `kind` flows into `SubmitTransactPayload.kind`, which routes the on-chain
// call, so it is a required argument here rather than something a wrapper
// supplies. `spend.test.ts` asserts each kind end to end.

import { assertU64 } from "../core/field.js";
import type { Field } from "../crypto/index.js";
import type { Note } from "../notes/note.js";
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
        throw new Error(`${kind}: at least one real input required`);
    }
    if (
        a.outputs.length !== a.outputRecipients.length ||
        a.outputs.length !== a.outputRandomness.length
    ) {
        throw new Error(
            `${kind}: outputs, outputRecipients and outputRandomness must be the same length ` +
                `(got ${a.outputs.length}, ${a.outputRecipients.length}, ${a.outputRandomness.length})`,
        );
    }

    assertBalance(a, publicOut);
    assertProvable(a, publicOut);

    const realIns = buildInputs(P, a.inputs, a.treeDepth);
    const firstNullifier = realIns[0]?.nf;
    if (firstNullifier === undefined) throw new Error(`${kind}: no input slots`);

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
 * Everything here is cheap and local, and every one of these mistakes
 * otherwise survives witness construction to fail five to sixty seconds later
 * inside the prover — as an opaque circom assertion, or worse, as a
 * valid-looking proof against the wrong root that only the chain rejects.
 *
 * The balance check above is deliberately not enough: it sums values across
 * slots without regard to `asset`, so a mixed-asset selection passes it and
 * fails inside the circuit.
 */
function assertProvable(a: SpendArgs, publicOut: bigint): void {
    assertArity(a);
    assertU64(publicOut, `${a.kind}: publicOut`);
    for (const [i, slot] of a.inputs.entries()) assertInputSlot(a, slot, i);
    for (const [i, note] of a.outputs.entries()) assertOutputSlot(a, note, i);
}

/**
 * Slot counts against the shape the caller named.
 *
 * Optional because `toCircomInput` reads the shape off the array lengths and
 * does not need telling — but that is exactly why a mismatch is invisible: a
 * 2-output spend against a 3x3 key builds a perfectly valid witness with the
 * wrong number of public inputs and fails inside the prover.
 */
function assertArity({ kind, shape, inputs, outputs }: SpendArgs): void {
    if (!shape) return;
    const name = `${shape.nIn}x${shape.nOut}`;
    if (inputs.length !== shape.nIn) {
        throw new Error(
            `${kind}: ${inputs.length} input slots for a ${name} circuit; ` +
                "pad unused slots with null",
        );
    }
    if (outputs.length !== shape.nOut) {
        throw new Error(
            `${kind}: ${outputs.length} output slots for a ${name} circuit; ` +
                "pad unused slots with zero-value notes",
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

function assertOutputSlot(a: SpendArgs, note: Note, i: number): void {
    assertU64(note.value, `${a.kind}: output slot ${i} value`);
}

/** Running total per asset id. */
function tally(into: Map<bigint, bigint>, asset: bigint, value: bigint): void {
    into.set(asset, (into.get(asset) ?? 0n) + value);
}

/**
 * Value conservation, checked per asset.
 *
 * This mirrors `PerAssetValueBalance` in `circuits/src/lib/balance.circom`,
 * which is what the proof will actually be held to: the circuit places no
 * constraint linking one slot's asset to another's, and instead requires
 *
 *     Σ in[asset] + public_in[asset]  ==  Σ out[asset] + public_out[asset]
 *
 * independently for every asset present. That is what lets one spend carry the
 * asset being moved alongside a second asset paying the relayer's fee.
 *
 * A single sum across every slot — which is what this used to be — is not the
 * same check. It accepts a spend that mints one asset and burns another in
 * equal measure, which is precisely the forgery `PerAssetValueBalance` exists
 * to reject, and hands it to the prover to fail seconds later inside circom.
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
        // `publicOut` is named separately from the output total it is folded
        // into: the two have different causes, and a withdraw that is short by
        // exactly the fee reads very differently from one whose change is wrong.
        const bucket = asset === a.asset ? ` publicOut=${publicOut}` : "";
        throw new Error(`${a.kind} balance for asset ${asset}: in=${inSum} out=${outSum}${bucket}`);
    }
}

/**
 * A path of the wrong shape still builds a witness — and proves against a root
 * that is not the tree's. A binary-shaped path from a mis-implemented relayer
 * (one sibling per level, indices 0/1) is the case that motivates this.
 */
function assertPathShape(
    kind: string,
    slot: number,
    treeDepth: number,
    pathElements: readonly (readonly bigint[])[],
    pathIndices: readonly number[],
): void {
    if (pathElements.length !== treeDepth || pathIndices.length !== treeDepth) {
        throw new Error(
            `${kind}: input slot ${slot} has a ${pathElements.length}-level path ` +
                `(${pathIndices.length} indices) for a depth-${treeDepth} tree`,
        );
    }
    for (let lvl = 0; lvl < treeDepth; lvl++) {
        const sibs = pathElements[lvl]!;
        if (sibs.length !== MERKLE_ARITY - 1) {
            throw new Error(
                `${kind}: input slot ${slot} level ${lvl} has ${sibs.length} siblings, ` +
                    `expected ${MERKLE_ARITY - 1}`,
            );
        }
        const idx = pathIndices[lvl]!;
        if (!Number.isInteger(idx) || idx < 0 || idx >= MERKLE_ARITY) {
            throw new Error(
                `${kind}: input slot ${slot} level ${lvl} has index ${idx}, ` +
                    `expected 0..${MERKLE_ARITY - 1}`,
            );
        }
    }
}
