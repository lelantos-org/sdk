// On-chain protocol structs for the deposit path.
//
// These mirror `PubInputs.sol` field-for-field. They live in `protocol/`
// because the chain adapter, the relayer codec, and the aux digest all consume
// them; none of those should depend on the Permit2 signer.
//
// The ABI component lists and the functions mapping a struct onto them are
// colocated. Their two consumers, the `computePiHash` witness and the calldata
// in `chain/viem/deposits.ts`, must agree field-for-field, since the hash is a
// Permit2 witness over the struct the calldata carries. A mismatch produces a
// signature the contract rejects, with no local symptom.

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
 * The depositor's output is not padded to a spend's output shape, so there is
 * no pad-leaf blinder.
 */
export interface DepositRequest {
    /** Full-width `uint256`, matching `Transact.chainId`. */
    chainId: bigint;
    publicAssetId: bigint;
    publicIn: bigint;
    payer: string; // 0x address
    recipient: string; // 0x address
    /** Output commitment. 0x-hex 32 B. */
    outCm: string;
    /**
     * Pedersen value commitment cv_dep = value · V^asset + rcv_dep · H.
     * Anchors (asset_id, value) into the Merkle leaf via
     * leaf = Poseidon(TAG_LEAF, cm, cv_dep_x, cv_dep_y).
     */
    cvDep: [bigint, bigint];
    /**
     * The output's `rcv_dep`. Published in the DepositEscrowed event so the
     * relayer can build the tree_update_batch witness without learning
     * recipient pk/rho/rcm. A Pedersen blinder is information-theoretically
     * independent of value/asset/identity, so it leaks nothing useful.
     */
    rcv: bigint;
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
     * may be zero; a chain that subsidises deposits still mints the leaf, so
     * the shape is fixed.
     */
    feeIn: bigint;
    feeCm: string;
    feeCvDep: [bigint, bigint];
    feeRcv: bigint;
}

/**
 * Component list of `AuxValidation.Output`. Shared by the deposit witness hash
 * and by `auxDigest` (the transact aux binding) so the two encodings cannot
 * drift apart. MUST match the struct in PubInputs.sol field-for-field.
 *
 * @internal
 */
export const AUX_OUTPUT_COMPONENTS = [
    { name: "clueRx", type: "uint256" },
    { name: "clueRy", type: "uint256" },
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
 * allowances.
 *
 * `spender` is shared across entries because it is always the MASP address.
 * `details[i].nonce` is per entry: Permit2 keys nonces by
 * `(owner, token, spender)`, read from `IAllowanceTransfer.allowance(owner, token, spender)`.
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

// ─── struct → ABI tuple ──────────────────────────────────────────────────────
//
// The `as` casts narrow `string` to viem's `0x${string}`. The values are
// already branded `EvmAddress` / `Hex32` at their source, so this is a
// representation change, not an unchecked assertion.

/**
 * `DepositRequest` as the tuple `DEPOSIT_REQUEST_COMPONENTS` describes.
 *
 * @internal
 */
export function depositTuple(deposit: DepositRequest) {
    // Lowercased: viem rejects a mixed-case address whose checksum does not
    // match, and the encoded bytes are the same either way.
    return {
        chainId: deposit.chainId,
        publicAssetId: deposit.publicAssetId,
        publicIn: deposit.publicIn,
        payer: abiAddress(deposit.payer),
        recipient: abiAddress(deposit.recipient),
        outCm: deposit.outCm as `0x${string}`,
        cvDep: deposit.cvDep,
        rcv: deposit.rcv,
        feeAssetId: deposit.feeAssetId,
        feeIn: deposit.feeIn,
        feeCm: deposit.feeCm as `0x${string}`,
        feeCvDep: deposit.feeCvDep,
        feeRcv: deposit.feeRcv,
    };
}

/** `0x`-hex address with no checksum casing, which viem accepts unconditionally. @internal */
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
        ephPubX: aux.ephPubX,
        ephPubY: aux.ephPubY,
        ciphertext: bytesToHex(aux.ciphertext) as `0x${string}`,
    };
}
