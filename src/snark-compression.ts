// SnarkCompression: collapse N logical Groth16 public inputs into the 2
// signals (z, y) the verifier actually sees. Off-chain reference for
// contracts/src/MASP.sol::_compressPubInputs (transact_2x2, 20 slots) and
// _compressTreeUpdatePI (tree_update, 5 slots).
//
// Slot order MUST match contracts/src/MASP.sol byte-for-byte AND the
// snarkjs publicSignals order written by fixture generators.

import { AbiCoder, keccak256 } from "ethers";
import type { Field } from "./crypto/index.js";

// BN254 scalar field (Groth16 curve).
export const BN254_R =
    21888242871839275222246405745257275088548364400416034343698204186575808495617n;

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
    /// Per-output FMD clue PIs. Required: matches circuit slots 20..25.
    out_clue_Rx?: (string | bigint)[];
    out_clue_Ry?: (string | bigint)[];
    out_clue_bits?: (string | bigint)[];
}

// 26-slot flatten in MASP._flatten order: 20 base + 3·N_OUT clue.
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

// Tree-update circuit PI shape. 5 slots in the order the contract's
// _compressTreeUpdatePI emits them.
export interface TreeUpdateFlattenInput {
    old_root: string | bigint;
    new_root: string | bigint;
    cm0: string | bigint;
    cm1: string | bigint;
    start_index: string | bigint | number;
}

export function flattenTreeUpdate(input: TreeUpdateFlattenInput): Field[] {
    return [
        BigInt(input.old_root),
        BigInt(input.new_root),
        BigInt(input.cm0),
        BigInt(input.cm1),
        BigInt(input.start_index),
    ];
}

// Solidity equivalent (MASP._compressPubInputs):
//   uint256[] memory s = new uint256[](20); ...
//   uint256 z = uint256(keccak256(abi.encode(s))) % R;
// Dynamic uint256[] → length prefix + words. Match exactly.
export function fiatShamirZ(coeffs: Field[]): Field {
    const packed = AbiCoder.defaultAbiCoder().encode(
        ["uint256[]"],
        [coeffs.map((c) => c.toString())],
    );
    return BigInt(keccak256(packed)) % BN254_R;
}

// y = c[0] + c[1]·z + c[2]·z² + … (low-to-high) mod R, via Horner.
export function hornerEval(coeffs: Field[], z: Field): Field {
    let acc = 0n;
    for (let i = coeffs.length - 1; i >= 0; i--) {
        acc = (acc * z + coeffs[i]) % BN254_R;
    }
    return acc;
}
