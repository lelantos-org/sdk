// Uniswap Permit2 witness signing for MASP deposits.
//
// Flow: build DepositIntent + AuxValidation.Output[2], hash via abi.encode +
// keccak (matches MASP._permit2Pull), wrap piHash in EIP-712 `MASPDeposit`
// witness, sign the outer Permit2 `PermitWitnessTransferFrom` typed-data.
//
// Witness type-string MUST match MASP._DEPOSIT_WITNESS_TYPE_STRING.

import {
    encodeAbiParameters,
    keccak256,
    type TypedDataDomain,
    type TypedDataParameter,
} from "viem";
import type { EthSigner } from "../chain/eth-signer.js";
import { bytesToHex } from "../utils/wire.js";

/** @internal */
/// Canonical Uniswap Permit2 deployment (deterministic CREATE2).
export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

/** @internal */
/// Mirror of `MASP._DEPOSIT_WITNESS_TYPE_STRING`. Sole source of truth for
/// the witness type-string consumed by Permit2 on-chain.
export const MASP_DEPOSIT_WITNESS_TYPE_STRING =
    "MASPDeposit witness)MASPDeposit(bytes32 piHash)TokenPermissions(address token,uint256 amount)";

/// EIP-712 type definitions matching Permit2 + MASPDeposit witness.
const PERMIT2_TYPES: Record<string, TypedDataParameter[]> = {
    PermitWitnessTransferFrom: [
        { name: "permitted", type: "TokenPermissions" },
        { name: "spender", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "witness", type: "MASPDeposit" },
    ],
    TokenPermissions: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
    ],
    MASPDeposit: [{ name: "piHash", type: "bytes32" }],
};

/// `PubInputs.DepositIntent` mirror — wire-side bigints/hex.
export interface DepositIntent {
    chainId: bigint;
    publicAssetId: bigint;
    publicIn: bigint;
    payer: string; // 0x address
    recipient: string; // 0x address
    /// Two output commitments. 0x-hex 32 B each.
    outCm: [string, string];
    /// Per-output Pedersen value commitment cv_dep_j = value_j · V^asset
    /// + rcv_dep_j · H. Anchors (asset_id, value) into the Merkle leaf via
    /// leaf_j = Poseidon(TAG_LEAF, cm_j, cv_dep_j_x, cv_dep_j_y).
    cvDep0: [bigint, bigint];
    cvDep1: [bigint, bigint];
    /// Sum rcv_dep_0 + rcv_dep_1. Published in the IntentEscrowed event so
    /// the relayer can build the tree_update_batch witness without learning
    /// recipient pk/rho/rcm. Pedersen blinder is information-theoretically
    /// independent of value/asset/identity, so leaks nothing useful.
    rcvTotal: bigint;
}

/// `AuxValidation.Output` mirror.
export interface AuxOutput {
    clueRx: bigint;
    clueRy: bigint;
    ephPubX: bigint;
    ephPubY: bigint;
    /// Raw bytes (2B clueBits prefix || ChaCha20Poly1305 body).
    ciphertext: Uint8Array;
}

/** @internal */
export interface Permit2Sig {
    nonce: bigint;
    deadline: bigint;
    /// Caller's ceiling on `inAmt + fee`. Bound into the Permit2 sig as
    /// `permitted.amount`; the contract requests at most this amount.
    maxTotal: bigint;
    /// 65-byte (r||s||v) hex string.
    signature: string;
}

/** @internal */
export interface SignPermit2Args {
    signer: EthSigner;
    chainId: bigint;
    /// MASP contract address (the Permit2 spender).
    spender: string;
    /// ERC-20 being pulled into escrow.
    token: string;
    /// Caller's ceiling on `inAmt + fee` in token base units.
    maxTotal: bigint;
    nonce: bigint;
    /// Unix-seconds Permit2 expiry.
    deadline: bigint;
    /// keccak256(abi.encode(DepositIntent, AuxValidation.Output[2])).
    piHash: string;
    /// Optional override for the Permit2 contract address (non-standard
    /// deployments). Defaults to the canonical deterministic CREATE2 addr.
    permit2Address?: string;
}

export async function signPermit2Witness(args: SignPermit2Args): Promise<Permit2Sig> {
    const verifyingContract = (args.permit2Address ?? PERMIT2_ADDRESS) as `0x${string}`;
    const domain: TypedDataDomain = {
        name: "Permit2",
        chainId: args.chainId,
        verifyingContract,
    };
    const message = {
        permitted: { token: args.token, amount: args.maxTotal },
        spender: args.spender,
        nonce: args.nonce,
        deadline: args.deadline,
        witness: { piHash: args.piHash },
    };
    const signature = await args.signer.signTypedData(
        domain,
        PERMIT2_TYPES,
        "PermitWitnessTransferFrom",
        message,
    );
    return { nonce: args.nonce, deadline: args.deadline, maxTotal: args.maxTotal, signature };
}

/// Compute `piHash = keccak256(abi.encode(DepositIntent, AuxValidation.Output[2]))`.
/// Mirrors MASP.submitIntent line `keccak256(abi.encode(d, aux))`.
export function computePiHash(intent: DepositIntent, aux: [AuxOutput, AuxOutput]): string {
    const encoded = encodeAbiParameters(
        [
            {
                type: "tuple",
                components: [
                    { name: "chainId", type: "uint64" },
                    { name: "publicAssetId", type: "uint64" },
                    { name: "publicIn", type: "uint64" },
                    { name: "payer", type: "address" },
                    { name: "recipient", type: "address" },
                    { name: "outCm", type: "bytes32[2]" },
                    { name: "cvDep0", type: "uint256[2]" },
                    { name: "cvDep1", type: "uint256[2]" },
                    { name: "rcvTotal", type: "uint256" },
                ],
            },
            {
                type: "tuple[2]",
                components: [
                    { name: "clueRx", type: "uint256" },
                    { name: "clueRy", type: "uint256" },
                    { name: "ephPubX", type: "uint256" },
                    { name: "ephPubY", type: "uint256" },
                    { name: "ciphertext", type: "bytes" },
                ],
            },
        ],
        [
            {
                chainId: intent.chainId,
                publicAssetId: intent.publicAssetId,
                publicIn: intent.publicIn,
                payer: intent.payer as `0x${string}`,
                recipient: intent.recipient as `0x${string}`,
                outCm: intent.outCm as [`0x${string}`, `0x${string}`],
                cvDep0: intent.cvDep0,
                cvDep1: intent.cvDep1,
                rcvTotal: intent.rcvTotal,
            },
            aux.map((a) => ({
                clueRx: a.clueRx,
                clueRy: a.clueRy,
                ephPubX: a.ephPubX,
                ephPubY: a.ephPubY,
                ciphertext: bytesToHex(a.ciphertext) as `0x${string}`,
            })) as never,
        ],
    );
    return keccak256(encoded);
}

// AllowanceTransfer mode — drops per-deposit Permit2 sig.

/** @internal */
/// Mirror of `IAllowanceTransfer.PermitDetails`.
export interface PermitDetails {
    token: string;
    /// uint160 cap on the spender's pull, in token base units.
    amount: bigint;
    /// uint48 unix-seconds expiry of the allowance window.
    expiration: number;
    /// uint48 incrementing per (owner, token, spender). Read via
    /// `IAllowanceTransfer.allowance(owner, token, spender)`.
    nonce: number;
}

/** @internal */
/// Mirror of `IAllowanceTransfer.PermitSingle`.
export interface PermitSingle {
    details: PermitDetails;
    /// MASP contract address.
    spender: string;
    /// Outer EIP-712 deadline for the `permit()` call itself (separate
    /// from `details.expiration` which gates each future pull).
    sigDeadline: bigint;
}

const PERMIT2_ALLOWANCE_TYPES: Record<string, TypedDataParameter[]> = {
    PermitSingle: [
        { name: "details", type: "PermitDetails" },
        { name: "spender", type: "address" },
        { name: "sigDeadline", type: "uint256" },
    ],
    PermitDetails: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint160" },
        { name: "expiration", type: "uint48" },
        { name: "nonce", type: "uint48" },
    ],
};

/** @internal */
export interface SignPermit2AllowanceArgs {
    signer: EthSigner;
    chainId: bigint;
    permit: PermitSingle;
    /// Optional Permit2 contract override; defaults to canonical CREATE2.
    permit2Address?: string;
}

/** @internal */
/// Sign a Permit2 `PermitSingle` for AllowanceTransfer-mode deposits. The
/// resulting `(permit, signature)` pair is submitted on-chain via
/// `IAllowanceTransfer.permit(owner, permitSingle, signature)` once; all
/// future deposits inside the window pull via `transferFrom` with no sig.
export async function signPermit2Allowance(
    args: SignPermit2AllowanceArgs,
): Promise<{ permit: PermitSingle; signature: string }> {
    const verifyingContract = (args.permit2Address ?? PERMIT2_ADDRESS) as `0x${string}`;
    const domain: TypedDataDomain = {
        name: "Permit2",
        chainId: args.chainId,
        verifyingContract,
    };
    const signature = await args.signer.signTypedData(
        domain,
        PERMIT2_ALLOWANCE_TYPES,
        "PermitSingle",
        args.permit as unknown as Record<string, unknown>,
    );
    return { permit: args.permit, signature };
}
