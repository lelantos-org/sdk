// Uniswap Permit2 witness signing for MASP deposits.
//
// Flow: build DepositRequest + AuxValidation.Output[2], hash via abi.encode +
// keccak (matches MASP._permit2Pull), wrap piHash in EIP-712 `MASPDeposit`
// witness, sign the outer Permit2 `PermitWitnessTransferFrom` typed-data.
//
// Witness type-string MUST match MASP._DEPOSIT_WITNESS_TYPE_STRING.

import type { TypedDataDomain, TypedDataParameter } from "viem";
import type { EthSigner } from "../core/signer.js";
import {
    AUX_OUTPUT_COMPONENTS,
    type AuxOutput,
    type DepositRequest,
    PERMIT2_ADDRESS,
    type Permit2Sig,
    type PermitBatch,
    type PermitDetails,
    type PermitSingle,
} from "../protocol/deposit-request.js";

export {
    AUX_OUTPUT_COMPONENTS,
    type AuxOutput,
    type DepositRequest,
    PERMIT2_ADDRESS,
    type Permit2Sig,
    type PermitBatch,
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
    /** keccak256(abi.encode(DepositRequest, AuxValidation.Output[2])). */
    piHash: string;
    /**
     * Optional override for the Permit2 contract address (non-standard
     * deployments). Defaults to the canonical deterministic CREATE2 addr.
     */
    permit2Address?: string;
}

/**
 * The EIP-712 domain every Permit2 signature is bound to.
 *
 * One statement of it: the three signature families below all sign against the
 * same contract, and a non-canonical deployment or a domain-field change has to
 * reach all three or they silently disagree.
 */
function permit2Domain(chainId: bigint, permit2Address?: string): TypedDataDomain {
    return {
        name: "Permit2",
        chainId,
        verifyingContract: (permit2Address ?? PERMIT2_ADDRESS) as `0x${string}`,
    };
}

export async function signPermit2Witness(args: SignPermit2Args): Promise<Permit2Sig> {
    const domain = permit2Domain(args.chainId, args.permit2Address);
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

/**
 * The `PermitDetails` member list, shared by both allowance structs.
 *
 * It has to match `PermitHash._PERMIT_DETAILS_TYPEHASH` on chain; two copies
 * would let a fix land on one and produce signatures that verify locally
 * against the stale table and revert on chain.
 */
const PERMIT_DETAILS: TypedDataParameter[] = [
    { name: "token", type: "address" },
    { name: "amount", type: "uint160" },
    { name: "expiration", type: "uint48" },
    { name: "nonce", type: "uint48" },
];

const PERMIT2_ALLOWANCE_TYPES: Record<string, TypedDataParameter[]> = {
    PermitSingle: [
        { name: "details", type: "PermitDetails" },
        { name: "spender", type: "address" },
        { name: "sigDeadline", type: "uint256" },
    ],
    PermitDetails: PERMIT_DETAILS,
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
    return signAllowanceStruct(args, PERMIT2_ALLOWANCE_TYPES, "PermitSingle");
}

/**
 * The body both allowance signers share: bind to the Permit2 domain, sign the
 * struct, hand back the pair. They differ only in the type table and the
 * primary type.
 */
async function signAllowanceStruct<T>(
    args: { signer: EthSigner; chainId: bigint; permit: T; permit2Address?: string },
    types: Record<string, TypedDataParameter[]>,
    primaryType: "PermitSingle" | "PermitBatch",
): Promise<{ permit: T; signature: string }> {
    const signature = await args.signer.signTypedData(
        permit2Domain(args.chainId, args.permit2Address),
        types,
        primaryType,
        args.permit as unknown as Record<string, unknown>,
    );
    return { permit: args.permit, signature };
}

// AllowanceTransfer batch mode — one signature for N token allowances.

/**
 * Permit2 hashes the array member as
 * `keccak256(abi.encodePacked(perDetailHashes))` — see
 * `PermitHash.hash(IAllowanceTransfer.PermitBatch)` — which is exactly what
 * EIP-712 prescribes for a struct array, so viem's `hashTypedData` produces it
 * with no manual encoding.
 */
const PERMIT2_ALLOWANCE_BATCH_TYPES: Record<string, TypedDataParameter[]> = {
    PermitBatch: [
        { name: "details", type: "PermitDetails[]" },
        { name: "spender", type: "address" },
        { name: "sigDeadline", type: "uint256" },
    ],
    PermitDetails: PERMIT_DETAILS,
};

/** @internal */
export interface SignPermit2AllowanceBatchArgs {
    signer: EthSigner;
    chainId: bigint;
    permit: PermitBatch;
    /** Optional Permit2 contract override; defaults to canonical CREATE2. */
    permit2Address?: string;
}

/**
 * Sign a Permit2 `PermitBatch` — the N-token twin of
 * {@link signPermit2Allowance}. Submitted on-chain via the
 * `permit(owner, PermitBatch, signature)` overload, after which every token in
 * the batch pulls through `transferFrom` with no further signature.
 *
 * Permit2 reverts the whole batch if any one `details[i].nonce` is stale, so
 * read the nonces immediately before calling this.
 *
 * @internal
 */
export async function signPermit2AllowanceBatch(
    args: SignPermit2AllowanceBatchArgs,
): Promise<{ permit: PermitBatch; signature: string }> {
    return signAllowanceStruct(args, PERMIT2_ALLOWANCE_BATCH_TYPES, "PermitBatch");
}
