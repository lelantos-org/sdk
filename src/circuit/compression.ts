// SnarkCompression: the logical public inputs, the Fiat-Shamir challenge they hash to, the subset
// the polynomial evaluates, and the digest that commits that subset. Mirrors
// `PubInputs.compress(Transact)` on-chain and `TransactCompressN` in the circuit.
//
// The circuit exposes three public signals, `[y, digest, z]`. `coeffs` is what `y` evaluates and
// the digest absorbs; `flatten` is every logical public input and is what `z` hashes. `PolyEval`
// is affine in each coefficient and the prover reads `z` before choosing a witness, so `y` binds
// only because the digest, hashed into `z`, fixes the witness's coefficients first. See
// `coeffCount` in `protocol/shape.ts`.

import { poseidon5 } from "poseidon-lite/poseidon5";
import { encodeAbiParameters, keccak256 } from "viem";
import { assertField, BN254_FR, type Field } from "../core/field.js";
import { TAG_DIGEST } from "../crypto/index.js";
import { InvalidArgumentError } from "../errors/config.js";
import type { CircomCoeffInputs, CircomPublicInputs } from "./input.js";

/** Decimal strings (what the circuit witness carries) or bigints (PIs assembled by hand). */
type Loose<T> = T extends string
    ? string | bigint
    : T extends string[]
      ? readonly (string | bigint)[]
      : T;

/** The coefficient slots, derived from `CircomCoeffInputs`: what `transactDigest` commits. */
export type DigestInput = {
    readonly [K in keyof CircomCoeffInputs]: Loose<CircomCoeffInputs[K]>;
};

/** Every logical public input, derived from `CircomPublicInputs`. */
export type FlattenInput = {
    readonly [K in keyof CircomPublicInputs]: Loose<CircomPublicInputs[K]>;
};

/**
 * The PolyEval coefficient vector, in `TransactCompressN` order:
 *
 *   merkle_root, nullifier[N_IN], out_cm[N_OUT], public_asset_id, public_out
 *
 * `3 + N_IN + N_OUT` words, 13 at 4×6: the leading words of `flatten`, and what `hornerEval`
 * evaluates and `coeffDigest` absorbs. The shape is read off the input arrays.
 */
export function coeffs(input: DigestInput): Field[] {
    const c: Field[] = [BigInt(input.merkle_root)];
    for (const nf of input.nullifier) c.push(BigInt(nf));
    for (const cm of input.out_cm) c.push(BigInt(cm));
    c.push(BigInt(input.public_asset_id), BigInt(input.public_out));
    return c;
}

/**
 * Poseidon(5) fold over `words`, four per block, the last block zero-padded:
 *
 *   h_0     = Poseidon(TAG_DIGEST, w[0..3])
 *   h_{b+1} = Poseidon(h_b,        w[4b+4 .. 4b+7])
 *
 * Mirrors `CoeffDigest` in the circuits' `poly_eval.circom`. Binding reduces to
 * the collision resistance of Poseidon(5).
 *
 * Words must be canonical field elements: `poseidon-lite` reduces mod `r`, so
 * `x` and `x + r` would otherwise share a digest.
 */
export function coeffDigest(words: readonly Field[]): Field {
    if (words.length === 0) {
        throw new InvalidArgumentError("coeffDigest: need at least one word", {
            argument: "words",
        });
    }
    for (const [i, word] of words.entries()) assertField(word, `coeffDigest word ${i}`);
    let h: Field = TAG_DIGEST;
    for (let b = 0; 4 * b < words.length; b++) {
        const block: Field[] = [h];
        for (let i = 0; i < 4; i++) block.push(words[4 * b + i] ?? 0n);
        h = poseidon5(block);
    }
    return h;
}

/**
 * The digest of a transact's coefficients: the circuit's `digest` public
 * signal, and the word an honest prover puts in `PubInputs.Transact.digest`.
 */
export function transactDigest(input: DigestInput): Field {
    return coeffDigest(coeffs(input));
}

/**
 * Flatten the logical PIs into the Fiat-Shamir challenge preimage, in
 * `PubInputs.compress(Transact)` order:
 *
 *   the coefficients, the digest word, recipient, chainId, payer, relayer,
 *   intentHash, (clueRx, clueRy, clueBits) per output, the aux digest
 *
 * `10 + N_IN + 4·N_OUT` words (`challengeWordCount` in `protocol/shape.ts`), 38 at 4×6.
 *
 * This is the vector `fiatShamirZ` hashes, not the one `hornerEval` evaluates (that is
 * `coeffs`). `input.digest` is hashed as given, never recomputed: it is the calldata word the
 * verifier compares against the circuit's output, and hashing it fixes it before `z`.
 */
export function flatten(input: FlattenInput): Field[] {
    const nOut = input.out_cm.length;

    const words = coeffs(input);
    words.push(BigInt(requireScalar("digest", input.digest)));
    // Member order of `PubInputs.Transact`, which the contract calldata-copies.
    words.push(BigInt(input.recipient_address));
    words.push(BigInt(input.chain_id));
    words.push(BigInt(input.payer_address));
    words.push(BigInt(input.relayer_address));
    // A full field word, not an address.
    words.push(BigInt(input.intent_hash));

    // The clue slots are checked against `nOut`, not only against each other:
    // `SubmitTransactPayload.pubInputs` omits them (the relayer derives them from `aux`), so a
    // `FlattenInput` rebuilt from that wire shape would otherwise yield a short vector and a
    // different `z` that surfaces only as an on-chain verifier revert.
    const rx = requirePresent("out_clue_Rx", input.out_clue_Rx, nOut);
    const ry = requirePresent("out_clue_Ry", input.out_clue_Ry, nOut);
    const bits = requirePresent("out_clue_bits", input.out_clue_bits, nOut);
    for (let j = 0; j < nOut; j++) words.push(BigInt(rx[j]!), BigInt(ry[j]!), BigInt(bits[j]!));
    words.push(BigInt(input.out_aux_digest));
    return words;
}

/** A scalar slot that must be present: `BigInt(undefined)` would throw a bare `TypeError`. */
function requireScalar(field: string, value: string | bigint | undefined): string | bigint {
    if (value === undefined) {
        throw new InvalidArgumentError(`flatten: ${field} is absent`, { argument: field });
    }
    return value;
}

/** A slot group that must be present and exactly `want` long. */
function requirePresent(
    field: string,
    value: readonly (string | bigint)[] | undefined,
    want: number,
): readonly (string | bigint)[] {
    if (value === undefined) {
        throw new InvalidArgumentError(`flatten: ${field} is absent, expected ${want} entries`, {
            argument: field,
        });
    }
    if (value.length !== want) {
        throw new InvalidArgumentError(
            `flatten: ${field} has ${value.length} entries, expected ${want}`,
            { argument: field },
        );
    }
    return value;
}

/**
 * Horner-form polynomial evaluation in BN254 Fr. Mirrors the in-circuit `PolyEval` and on-chain
 * `PubInputs._finalizeRaw`. Takes `coeffs`' output, not `flatten`'s.
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
