// SnarkCompression: the logical public inputs, the Fiat-Shamir challenge they
// hash to, and the subset of them the polynomial evaluates.
// Mirrors `PubInputs.compress(Transact)` on-chain.
//
// Two vectors, not one. `flatten` is every logical public input and is what `z`
// hashes; `coeffs` is the strict subset the circuit pins and is what `y`
// evaluates. `PolyEval` is affine in each coefficient and the prover reads `z`
// before choosing a witness, so an unconstrained coefficient is one linear
// equation in one unknown — see `coeffCount` in `core/shape.ts`.

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
 * Flatten the logical PIs into the Fiat-Shamir challenge preimage, in
 * `PubInputs.compress(Transact)` order:
 *
 *   9 scalar slots + 3·N_IN (nullifier, in_cv) + 8·N_OUT (out_cm, out_cv,
 *   out_cv_dep, 3 clue slots) — see `challengeWordCount` in `core/shape.ts`,
 *   which is 69 at 4×6.
 *
 * This is the vector `fiatShamirZ` hashes, NOT the one `hornerEval` evaluates —
 * use `coeffs` for that. The two differ by the 23 fields the circuit does not
 * constrain, which bind through `z` precisely because they are hashed.
 *
 * The shape is read off the input arrays rather than hardcoded, so a witness
 * for any `Transact(DEPTH, N_IN, N_OUT)` instance flattens correctly.
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
    for (let j = 0; j < nOut; j++) {
        const [x, y] = requirePoint("out_cv_dep", input.out_cv_dep[j]);
        coeffs.push(BigInt(x));
        coeffs.push(BigInt(y));
    }
    // The four unpinned words follow every pinned one, so the coefficient
    // vector is this preimage's leading `coeffCount` words. Matches the member
    // order of `PubInputs.Transact`, which is what the contract calldata-copies.
    coeffs.push(BigInt(input.recipient_address));
    coeffs.push(BigInt(input.chain_id));
    coeffs.push(BigInt(input.payer_address));
    coeffs.push(BigInt(input.relayer_address));

    // Checked against `nOut`, like every other slot group. Checking the three
    // only against each other, or defaulting them to `[]`, would let a caller
    // that omits them build a short coefficient vector with no error raised.
    // `SubmitTransactPayload.pubInputs` omits the clue slots — the relayer
    // derives them from `aux`, see `protocol/transact.ts` — so a `FlattenInput`
    // reconstructed from that wire shape yields 33 coefficients instead of 42
    // at 3x3 and a different Fiat-Shamir `z`, surfacing only as an on-chain
    // verifier revert.
    for (const [rx, ry, bits] of clueSlots(input, nOut)) {
        coeffs.push(BigInt(rx));
        coeffs.push(BigInt(ry));
        coeffs.push(BigInt(bits));
    }
    coeffs.push(BigInt(input.out_aux_digest));
    return coeffs;
}

/**
 * The PolyEval coefficient vector: the subset of `flatten` the circuit pins.
 *
 *   4 scalar slots + 3·N_IN (nullifier, in_cv) + 5·N_OUT (out_cm, out_cv,
 *   out_cv_dep) — 46 at 4×6.
 *
 * Every entry is bound by a constraint in `4x6.circom` outside `PolyEval`: the
 * root by Merkle membership, the nullifiers and commitments by Poseidon, the
 * value commitments by `ValueCommit`, the three public scalars by
 * `RangeCheck64` and the balance. That membership rule is what makes `y`
 * binding; see `coeffCount` in `core/shape.ts`.
 */
export function coeffs(input: FlattenInput): Field[] {
    const nIn = input.nullifier.length;
    const nOut = input.out_cm.length;

    // The leading words of the preimage, not a second walk over the same order.
    // `PubInputs.Transact` orders its pinned members first precisely so this is a
    // prefix — see `TRANSACT_COEFFS` — and taking it as a slice makes that
    // structural instead of a property two functions have to keep agreeing on.
    // Slicing `flatten` also inherits its length and shape validation.
    return flatten(input).slice(0, 4 + 3 * nIn + 5 * nOut);
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
 * The three are checked against `nOut` like every other slot group, not just
 * against each other: `SubmitTransactPayload.pubInputs` omits the clue slots,
 * so a `FlattenInput` reconstructed from that wire shape would otherwise yield
 * 33 coefficients instead of 42 at 3x3 and a different Fiat-Shamir `z`.
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
 * `PolyEval` and on-chain `PubInputs._finalizeRaw`. Takes `coeffs`'
 * output, not `flatten`'s.
 */
export function hornerEval(coeffs: Field[], z: Field): Field {
    let acc = 0n;
    for (let i = coeffs.length - 1; i >= 0; i--) {
        acc = (acc * z + coeffs[i]!) % BN254_FR;
        if (acc < 0n) acc += BN254_FR;
    }
    return acc;
}

/** Takes `flatten`'s output: every logical public input, evaluated or not. */
export function fiatShamirZ(challenge: Field[]): Field {
    const packed = encodeAbiParameters([{ type: "uint256[]" }], [challenge]);
    return BigInt(keccak256(packed)) % BN254_FR;
}
