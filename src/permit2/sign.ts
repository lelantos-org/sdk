// Uniswap Permit2 witness signing for MASP deposits.
//
// Flow: build DepositIntent + AuxValidation.Output[2], hash via abi.encode +
// keccak (matches MASP._permit2Pull), wrap piHash in EIP-712 `MASPDeposit`
// witness, sign the outer Permit2 `PermitWitnessTransferFrom` typed-data.
//
// Witness type-string MUST match MASP._DEPOSIT_WITNESS_TYPE_STRING.

import type { TypedDataDomain, TypedDataParameter } from "viem";
import type { EthSigner } from "../core/signer.js";
import {
    AUX_OUTPUT_COMPONENTS,
    type AuxOutput,
    type DepositIntent,
    PERMIT2_ADDRESS,
    type Permit2Sig,
    type PermitDetails,
    type PermitSingle,
} from "../protocol/deposit-intent.js";

export {
    AUX_OUTPUT_COMPONENTS,
    type AuxOutput,
    type DepositIntent,
    PERMIT2_ADDRESS,
    type Permit2Sig,
    type PermitDetails,
    type PermitSingle,
};

/** EIP-712 type definitions matching Permit2 + MASPDeposit witness. */
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

/** @internal */
export interface SignPermit2Args {
    signer: EthSigner;
    chainId: bigint;
    /** MASP contract address (the Permit2 spender). */
    spender: string;
    /** ERC-20 being pulled into escrow. */
    token: string;
    /** Caller's ceiling on `inAmt + fee` in token base units. */
    maxTotal: bigint;
    nonce: bigint;
    /** Unix-seconds Permit2 expiry. */
    deadline: bigint;
    /** keccak256(abi.encode(DepositIntent, AuxValidation.Output[2])). */
    piHash: string;
    /**
     * Optional override for the Permit2 contract address (non-standard
     * deployments). Defaults to the canonical deterministic CREATE2 addr.
     */
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

// AllowanceTransfer mode — drops per-deposit Permit2 sig.

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
    /** Optional Permit2 contract override; defaults to canonical CREATE2. */
    permit2Address?: string;
}

/**
 * Sign a Permit2 `PermitSingle` for AllowanceTransfer-mode deposits. The
 * resulting `(permit, signature)` pair is submitted on-chain via
 * `IAllowanceTransfer.permit(owner, permitSingle, signature)` once; all
 * future deposits inside the window pull via `transferFrom` with no sig.
 *
 * @internal
 */
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
