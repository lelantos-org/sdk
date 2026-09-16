// SnarkCompression: the logical public inputs, the Fiat-Shamir challenge they
// hash to, and the subset of them the polynomial evaluates.
// Mirrors `PubInputs.compress(Transact)` on-chain.
//
// Two vectors, not one. `flatten` is every logical public input and is what `z`
// hashes; `coeffs` is the strict subset the circuit pins and is what `y`
// evaluates. `PolyEval` is affine in each coefficient and the prover reads `z`
// before choosing a witness, so an unconstrained coefficient is one linear
// equation in one unknown — see `coeffCount` in `protocol/shape.ts`.

import { encodeAbiParameters, keccak256 } from "viem";
import { BN254_FR, type Field } from "../core/field.js";
import { InvalidArgumentError } from "../errors/config.js";
import { coeffCount } from "../protocol/shape.js";
import type { CircomPublicInputs } from "./input.js";

/**
 * `flatten` accepts either decimal strings (what the circuit witness carries)
 * or native bigints (what callers assembling PIs by hand supply).
 *
 * Derived from `CircomPublicInputs` so the two stay in sync and no cast is
 * needed at the call site.
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
 *   10 scalar slots + 3·N_IN (nullifier, in_cv) + 8·N_OUT (out_cm, out_cv,
 *   out_cv_dep, 3 clue slots) — see `challengeWordCount` in `protocol/shape.ts`,
 *   which is 70 at 4×6.
 *
 * This is the vector `fiatShamirZ` hashes, not the one `hornerEval` evaluates
 * (use `coeffs` for that). The two differ by the 24 fields the circuit does not
 * constrain, which are bound through `z` because they are hashed.
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
    for (const field of ["in_cv", "out_cv", "out_cv_dep"] as const) {
        for (const point of input[field]) {
            const [x, y] = requirePoint(field, point);
            coeffs.push(BigInt(x), BigInt(y));
        }
    }
    // The five unpinned words follow every pinned one, so the coefficient
    // vector is this preimage's leading `coeffCount` words. Matches the member
    // order of `PubInputs.Transact`, which the contract calldata-copies.
    coeffs.push(BigInt(input.recipient_address));
    coeffs.push(BigInt(input.chain_id));
    coeffs.push(BigInt(input.payer_address));
    coeffs.push(BigInt(input.relayer_address));
    // Only `SwapWrapper.swap` reads it (the swap intent's hash); every other
    // spend binds zero. A full field word, not an address.
    coeffs.push(BigInt(input.intent_hash));

    // The clue slots are checked against `nOut` like every other slot group, not
    // only against each other: `SubmitTransactPayload.pubInputs` omits them (the
    // relayer derives them from `aux`), so a `FlattenInput` rebuilt from that wire
    // shape would otherwise yield a short vector and a different `z` that surfaces
    // only as an on-chain verifier revert.
    const rx = requirePresent("out_clue_Rx", input.out_clue_Rx, nOut);
    const ry = requirePresent("out_clue_Ry", input.out_clue_Ry, nOut);
    const bits = requirePresent("out_clue_bits", input.out_clue_bits, nOut);
    for (let j = 0; j < nOut; j++) coeffs.push(BigInt(rx[j]!), BigInt(ry[j]!), BigInt(bits[j]!));
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
 * binding; see `coeffCount` in `protocol/shape.ts`.
 */
export function coeffs(input: FlattenInput): Field[] {
    const shape = { nIn: input.nullifier.length, nOut: input.out_cm.length };
    // `PubInputs.Transact` orders its pinned members first so the coefficients
    // are a prefix of the preimage (see `TRANSACT_COEFFS`). Slicing `flatten`
    // keeps the two orders identical and reuses its length and shape validation.
    return flatten(input).slice(0, coeffCount(shape));
}

/** A curve-point slot is always `(x, y)`; the arity is part of the layout. */
function requirePoint(
    field: string,
    value: readonly (string | bigint)[] | undefined,
): [string | bigint, string | bigint] {
    if (value?.length !== 2) {
        throw new InvalidArgumentError(
            `flatten: ${field} entry has ${value?.length} coordinates, expected 2`,
            { argument: field },
        );
    }
    return [value[0] as string | bigint, value[1] as string | bigint];
}

/** A slot group that must be present and exactly `want` long. */
function requirePresent(
    field: string,
    value: readonly Loose<string>[] | undefined,
    want: number,
): Loose<string>[] {
    if (value === undefined) {
        throw new InvalidArgumentError(`flatten: ${field} is absent, expected ${want} entries`, {
            argument: field,
        });
    }
    requireLength(field, value, want);
    return [...value];
}

function requireLength(field: string, value: { length: number }, want: number): void {
    if (value.length !== want) {
        throw new InvalidArgumentError(
            `flatten: ${field} has ${value.length} entries, expected ${want}`,
            { argument: field },
        );
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
