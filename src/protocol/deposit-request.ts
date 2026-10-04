// On-chain protocol structs for the deposit path, mirroring `PubInputs.sol`
// field-for-field.
//
// `depositTuple` and `auxTuple` feed both the `computePiHash` witness and the
// calldata in `chain/viem/deposits.ts`. The two must agree field-for-field: the
// hash is a Permit2 witness over the struct the calldata carries, and a
// mismatch produces a signature the contract rejects, with no local symptom.

import { bytesToHex } from "../core/hex.js";

/**
 * Canonical Uniswap Permit2 deployment (deterministic CREATE2).
 *
 * @internal
 */
export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

/**
 * `PubInputs.DepositRequest` mirror, with wire-side bigints/hex.
 *
 * A deposit publishes `inner`, the owner half of each note, and never a leaf:
 * the batch circuit builds the leaf from the escrowed amount as
 * `Poseidon(TAG_CM, asset · 2^64 + value, inner)`.
 */
export interface DepositRequest {
    /** Full-width `uint256`, matching `Transact.chainId`. */
    chainId: bigint;
    publicAssetId: bigint;
    publicIn: bigint;
    payer: string; // 0x address
    recipient: string; // 0x address
    /**
     * `Poseidon(TAG_INNER, pk, rho, rcm)` of the depositor's note. 0x-hex 32 B.
     *
     * One that is not of that form, or whose preimage the recipient never
     * learns, escrows a deposit nobody can spend.
     */
    inner: string;
    /**
     * Registry id of the asset the relayer's fee note is paid in.
     *
     * `0` exactly when `feeIn` is zero: a zero-value leaf's asset is
     * canonically 0 in the circuit, and the pool reverts `FeeAssetMustBeZero`
     * otherwise. A valued note names either `publicAssetId` (one pull of the
     * deposit token) or another plain, enabled asset (a second pull, of that
     * token); see `isSameFeeAsset`.
     */
    feeAssetId: bigint;
    /**
     * The relayer's fee note value, in circuit units of `feeAssetId`.
     *
     * A deposit mints two leaves: the depositor's note and this one. `feeIn`
     * may be zero; the leaf is minted regardless.
     */
    feeIn: bigint;
    /** `inner` of the relayer's fee note. 0x-hex 32 B. */
    feeInner: string;
}

/**
 * Component list of `AuxValidation.Output`. Shared by the deposit witness hash
 * and by `auxDigest` (the transact aux binding) so the two encodings cannot
 * drift apart. Must match the struct in `PubInputs.sol` field-for-field.
 *
 * @internal
 */
export const AUX_OUTPUT_COMPONENTS = [
    { name: "clueRx", type: "uint256" },
    { name: "clueRy", type: "uint256" },
    { name: "clueQx", type: "uint256" },
    { name: "clueQy", type: "uint256" },
    { name: "ephPubX", type: "uint256" },
    { name: "ephPubY", type: "uint256" },
    { name: "ciphertext", type: "bytes" },
] as const;

/**
 * `AuxValidation.Output` mirror.
 *
 * @internal
 */
export interface AuxOutput {
    clueRx: bigint;
    clueRy: bigint;
    /** Subgroup witness for the clue: `[8]·(clueQx, clueQy) = (clueRx, clueRy)`. */
    clueQx: bigint;
    clueQy: bigint;
    ephPubX: bigint;
    ephPubY: bigint;
    /** Raw bytes (2B clueBits prefix || ChaCha20Poly1305 body). */
    ciphertext: Uint8Array;
}

/** @internal */
export interface Permit2Sig {
    nonce: bigint;
    deadline: bigint;
    /**
     * Caller's ceiling on the deposit token's pull, bound into the Permit2 sig
     * as the deposit token's `permitted.amount`; the contract requests at most
     * this amount.
     *
     * Covers `inAmt + fee`, plus the relayer note when it is paid in the
     * deposit's own asset.
     */
    maxTotal: bigint;
    /**
     * Caller's ceiling on the fee token's pull: the relayer note's value when
     * it is paid in another asset, signed as the second entry of a
     * `PermitBatchWitnessTransferFrom`.
     *
     * `0n` on the single-token path; the pool reverts `BadMaxFee` otherwise.
     */
    maxFee: bigint;
    /** 65-byte (r||s||v) hex string. */
    signature: string;
}

/**
 * Mirror of `IAllowanceTransfer.PermitDetails`.
 *
 * @internal
 */
export interface PermitDetails {
    token: string;
    /** uint160 cap on the spender's pull, in token base units. */
    amount: bigint;
    /** uint48 unix-seconds expiry of the allowance window. */
    expiration: number;
    /**
     * uint48 incrementing per (owner, token, spender). Read via
     * `IAllowanceTransfer.allowance(owner, token, spender)`.
     */
    nonce: number;
}

/**
 * Mirror of `IAllowanceTransfer.PermitSingle`.
 *
 * @internal
 */
export interface PermitSingle {
    details: PermitDetails;
    /** MASP contract address. */
    spender: string;
    /**
     * Outer EIP-712 deadline for the `permit()` call itself (separate
     * from `details.expiration` which gates each future pull).
     */
    sigDeadline: bigint;
}

/**
 * Mirror of `IAllowanceTransfer.PermitBatch`: one signature covering N token
 * allowances, each with its own nonce and a shared `spender`.
 *
 * @internal
 */
export interface PermitBatch {
    details: PermitDetails[];
    /** MASP contract address. */
    spender: string;
    /** Outer EIP-712 deadline for the `permit()` call itself. */
    sigDeadline: bigint;
}

// Struct to ABI tuple. The `as` casts narrow `string` to viem's `0x${string}`;
// the values are branded `EvmAddress` / `Hex32` at their source.

/**
 * `DepositRequest` as the tuple `DEPOSIT_REQUEST_COMPONENTS` describes.
 *
 * @internal
 */
export function depositTuple(deposit: DepositRequest) {
    return {
        chainId: deposit.chainId,
        publicAssetId: deposit.publicAssetId,
        publicIn: deposit.publicIn,
        payer: abiAddress(deposit.payer),
        recipient: abiAddress(deposit.recipient),
        inner: deposit.inner as `0x${string}`,
        feeAssetId: deposit.feeAssetId,
        feeIn: deposit.feeIn,
        feeInner: deposit.feeInner as `0x${string}`,
    };
}

/** Lowercased: viem rejects a mixed-case address whose checksum does not match. @internal */
export const abiAddress = (address: string): `0x${string}` =>
    address.toLowerCase() as `0x${string}`;

/**
 * `AuxOutput` as the tuple `AUX_OUTPUT_COMPONENTS` describes.
 *
 * @internal
 */
export function auxTuple(aux: AuxOutput) {
    return {
        clueRx: aux.clueRx,
        clueRy: aux.clueRy,
        clueQx: aux.clueQx,
        clueQy: aux.clueQy,
        ephPubX: aux.ephPubX,
        ephPubY: aux.ephPubY,
        ciphertext: bytesToHex(aux.ciphertext) as `0x${string}`,
    };
}
