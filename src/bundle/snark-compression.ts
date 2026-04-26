// SnarkCompression: collapse N logical Groth16 PIs into the 2 signals (z, y)
// the verifier sees. Off-chain reference for PubInputs.sol :: compress(Transact).
//
// Slot order MUST match on-chain compress() byte-for-byte AND snarkjs
// publicSignals order from fixture generators.

import { encodeAbiParameters, keccak256 } from "viem";
import type { Field } from "../crypto/index.js";

/** @internal */
// BN254 scalar field (Groth16 curve).
export const BN254_R =
    21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** @internal */
// Logical PI shape produced by `toCircomInput`. Generic over keys we read.
export interface FlattenInput {
    merkle_root: string | bigint;
    nullifier: (string | bigint)[];
    out_cm: (string | bigint)[];
    public_asset_id: string | bigint;
    public_in: string | bigint;
    public_out: string | bigint;
    in_cv: (string | bigint)[][];
    out_cv: (string | bigint)[][];
    recipient_address: string | bigint;
    chain_id: string | bigint;
    payer_address: string | bigint;
    relayer_address: string | bigint;
    /// Per-output Pedersen value commitment that anchors (asset, value) into
    /// the Merkle leaf. Required: matches circuit slots 20..23.
    out_cv_dep: (string | bigint)[][];
    /// Per-output FMD clue PIs. Required: matches circuit slots 24..29.
    out_clue_Rx?: (string | bigint)[];
    out_clue_Ry?: (string | bigint)[];
    out_clue_bits?: (string | bigint)[];
}

// 30-slot flatten in PubInputs.compress(Transact) order: 24 base + 3·N_OUT clue.
export function flatten(input: FlattenInput): Field[] {
    const base: Field[] = [
        BigInt(input.merkle_root),
        BigInt(input.nullifier[0]),
        BigInt(input.nullifier[1]),
        BigInt(input.out_cm[0]),
        BigInt(input.out_cm[1]),
        BigInt(input.public_asset_id),
        BigInt(input.public_in),
        BigInt(input.public_out),
        BigInt(input.in_cv[0][0]),
        BigInt(input.in_cv[0][1]),
        BigInt(input.in_cv[1][0]),
        BigInt(input.in_cv[1][1]),
        BigInt(input.out_cv[0][0]),
        BigInt(input.out_cv[0][1]),
        BigInt(input.out_cv[1][0]),
        BigInt(input.out_cv[1][1]),
        BigInt(input.recipient_address),
        BigInt(input.chain_id),
        BigInt(input.payer_address),
        BigInt(input.relayer_address),
        BigInt(input.out_cv_dep[0][0]),
        BigInt(input.out_cv_dep[0][1]),
        BigInt(input.out_cv_dep[1][0]),
        BigInt(input.out_cv_dep[1][1]),
    ];
    const Rx = input.out_clue_Rx ?? [];
    const Ry = input.out_clue_Ry ?? [];
    const cb = input.out_clue_bits ?? [];
    if (Rx.length !== Ry.length || Rx.length !== cb.length) {
        throw new Error("flatten: out_clue_{Rx,Ry,bits} length mismatch");
    }
    for (let j = 0; j < Rx.length; j++) {
        base.push(BigInt(Rx[j]));
        base.push(BigInt(Ry[j]));
        base.push(BigInt(cb[j]));
    }
    return base;
}

/// Horner-form polynomial evaluation in BN254 Fr. Mirrors the in-circuit
/// `PolyEval` and on-chain `PubInputs._evalY`.
export function hornerEval(coeffs: Field[], z: Field): Field {
    let acc = 0n;
    for (let i = coeffs.length - 1; i >= 0; i--) {
        acc = (acc * z + coeffs[i]) % BN254_R;
        if (acc < 0n) acc += BN254_R;
    }
    return acc;
}

export function fiatShamirZ(coeffs: Field[]): Field {
    const packed = encodeAbiParameters([{ type: "uint256[]" }], [coeffs]);
    return BigInt(keccak256(packed)) % BN254_R;
}
