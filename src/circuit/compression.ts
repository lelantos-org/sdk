// SnarkCompression: the 31-slot PI vector and its Fiat-Shamir challenge.
// Mirrors `PubInputs.compress(Transact)` on-chain.

import { encodeAbiParameters, keccak256 } from "viem";
import { BN254_FR, type Field } from "../core/field.js";
import type { CircomPublicInputs } from "./input.js";

/**
 * `flatten` accepts either decimal strings (what the circuit witness carries)
 * or native bigints (what callers assembling PIs by hand supply).
 *
 * Derived from `CircomPublicInputs` rather than re-declared, so the two cannot
 * drift and no cast is needed at the call site.
 */
type Loose<T> = T extends string
    ? string | bigint
    : T extends string[]
      ? readonly (string | bigint)[]
      : T extends string[][]
        ? readonly (readonly (string | bigint)[])[]
        : T;

export type FlattenInput = {
    readonly [K in keyof CircomPublicInputs]: Loose<CircomPublicInputs[K]>;
};

/**
 * Flatten the logical PIs into the PolyEval coefficient vector, in
 * `PubInputs.compress(Transact)` order:
 *
 *   9 scalar slots + 3·N_IN (nullifier, in_cv) + 8·N_OUT (out_cm, out_cv,
 *   out_cv_dep, 3 clue slots) — see `coeffCount` in `core/shape.ts`, which is
 *   31 at 2×2 and 42 at 3×3.
 *
 * The shape is read off the input arrays rather than hardcoded, so a witness
 * for any `Transact(DEPTH, N_IN, N_OUT)` instance flattens correctly. Only
 * the 2×2 circuit is deployed today; the 3×3 vectors exercise the rest.
 */
export function flatten(input: FlattenInput): Field[] {
    const nIn = input.nullifier.length;
    const nOut = input.out_cm.length;
    requireLength("in_cv", input.in_cv, nIn);
    requireLength("out_cv", input.out_cv, nOut);
    requireLength("out_cv_dep", input.out_cv_dep, nOut);

    const coeffs: Field[] = [BigInt(input.merkle_root)];
    for (let i = 0; i < nIn; i++) coeffs.push(BigInt(input.nullifier[i]!));
    for (let j = 0; j < nOut; j++) coeffs.push(BigInt(input.out_cm[j]!));
    coeffs.push(BigInt(input.public_asset_id));
    coeffs.push(BigInt(input.public_in));
    coeffs.push(BigInt(input.public_out));
    for (let i = 0; i < nIn; i++) {
        const [x, y] = requirePoint("in_cv", input.in_cv[i]);
        coeffs.push(BigInt(x));
        coeffs.push(BigInt(y));
    }
    for (let j = 0; j < nOut; j++) {
        const [x, y] = requirePoint("out_cv", input.out_cv[j]);
        coeffs.push(BigInt(x));
        coeffs.push(BigInt(y));
    }
    coeffs.push(BigInt(input.recipient_address));
    coeffs.push(BigInt(input.chain_id));
    coeffs.push(BigInt(input.payer_address));
    coeffs.push(BigInt(input.relayer_address));
    for (let j = 0; j < nOut; j++) {
        const [x, y] = requirePoint("out_cv_dep", input.out_cv_dep[j]);
        coeffs.push(BigInt(x));
        coeffs.push(BigInt(y));
    }

    // Checked against `nOut`, like every other slot group. Checking the three
    // only against each other — and defaulting them to `[]` — meant a caller
    // that omitted them got a short coefficient vector with no error at all.
    //
    // That is not hypothetical: `SubmitTransactPayload.pubInputs` deliberately
    // omits the clue slots, because the relayer derives them from `aux` (see
    // `protocol/transact.ts`). Anything reconstructing a `FlattenInput` from
    // that wire shape produced 33 coefficients instead of 42 at 3x3, hence a
    // completely different Fiat-Shamir `z` — surfacing only as an on-chain
    // verifier revert, with nothing local to point at.
    for (const [rx, ry, bits] of clueSlots(input, nOut)) {
        coeffs.push(BigInt(rx));
        coeffs.push(BigInt(ry));
        coeffs.push(BigInt(bits));
    }
    coeffs.push(BigInt(input.out_aux_digest));
    return coeffs;
}

/** A curve-point slot is always `(x, y)`; the arity is part of the layout. */
function requirePoint(
    field: string,
    value: readonly (string | bigint)[] | undefined,
): [string | bigint, string | bigint] {
    if (value?.length !== 2) {
        throw new Error(`flatten: ${field} entry has ${value?.length} coordinates, expected 2`);
    }
    return [value[0] as string | bigint, value[1] as string | bigint];
}

/** One output's three clue coefficients, in `PubInputs.compress` order. */
type ClueSlot = readonly [Loose<string>, Loose<string>, Loose<string>];

/**
 * The `nOut` clue triples, validated and zipped.
 *
 * Zipping is what makes the caller's reads total — destructuring a tuple needs
 * no non-null assertion, where three parallel indexed lookups would.
 *
 * The three are checked against `nOut` like every other slot group. Checking
 * them only against each other — and defaulting them to `[]` — meant a caller
 * that omitted them got a short coefficient vector with no error at all. That
 * is not hypothetical: `SubmitTransactPayload.pubInputs` deliberately omits
 * the clue slots because the relayer derives them from `aux` (see
 * `protocol/transact.ts`), so anything reconstructing a `FlattenInput` from
 * that wire shape produced 33 coefficients instead of 42 at 3x3 — a completely
 * different Fiat-Shamir `z`, surfacing only as an on-chain verifier revert.
 */
function clueSlots(input: FlattenInput, nOut: number): ClueSlot[] {
    const rx = requirePresent("out_clue_Rx", input.out_clue_Rx, nOut);
    const ry = requirePresent("out_clue_Ry", input.out_clue_Ry, nOut);
    const bits = requirePresent("out_clue_bits", input.out_clue_bits, nOut);

    const slots: ClueSlot[] = [];
    for (let j = 0; j < nOut; j++) {
        const x = rx[j];
        const y = ry[j];
        const b = bits[j];
        // Unreachable given the length checks above, but written out rather
        // than asserted away: a cast here would be the one place this function
        // could silently emit `undefined` into the coefficient vector.
        if (x === undefined || y === undefined || b === undefined) {
            throw new Error(`flatten: clue slot ${j} is incomplete`);
        }
        slots.push([x, y, b]);
    }
    return slots;
}

/** A slot group that must be present and exactly `want` long. */
function requirePresent(
    field: string,
    value: readonly Loose<string>[] | undefined,
    want: number,
): Loose<string>[] {
    if (value === undefined) {
        throw new Error(`flatten: ${field} is absent, expected ${want} entries`);
    }
    requireLength(field, value, want);
    return [...value];
}

function requireLength(field: string, value: { length: number }, want: number): void {
    if (value.length !== want) {
        throw new Error(`flatten: ${field} has ${value.length} entries, expected ${want}`);
    }
}

/**
 * Horner-form polynomial evaluation in BN254 Fr. Mirrors the in-circuit
 * `PolyEval` and on-chain `PubInputs._evalY`.
 */
export function hornerEval(coeffs: Field[], z: Field): Field {
    let acc = 0n;
    for (let i = coeffs.length - 1; i >= 0; i--) {
        acc = (acc * z + coeffs[i]!) % BN254_FR;
        if (acc < 0n) acc += BN254_FR;
    }
    return acc;
}

export function fiatShamirZ(coeffs: Field[]): Field {
    const packed = encodeAbiParameters([{ type: "uint256[]" }], [coeffs]);
    return BigInt(keccak256(packed)) % BN254_FR;
}
