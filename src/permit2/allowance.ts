// Permit2 AllowanceTransfer signing: one signed window, then deposits pull with no signature.

import type { TypedDataParameter } from "viem";
import type { EthSigner } from "../keys/signer.js";
import type { PermitBatch, PermitSingle } from "../protocol/deposit-request.js";
import { permit2Domain, signPermit } from "./common.js";

/**
 * The `PermitDetails` member list, shared by both allowance structs.
 *
 * Must match `PermitHash._PERMIT_DETAILS_TYPEHASH` on chain.
 */
const PERMIT_DETAILS: TypedDataParameter[] = [
    { name: "token", type: "address" },
    { name: "amount", type: "uint160" },
    { name: "expiration", type: "uint48" },
    { name: "nonce", type: "uint48" },
];

/**
 * The type table for `PermitSingle` or `PermitBatch`, which differ only in whether `details` is one
 * struct or an array.
 *
 * For the batch, Permit2 hashes the array member as `keccak256(abi.encodePacked(perDetailHashes))`
 * (see `PermitHash.hash(IAllowanceTransfer.PermitBatch)`), which is the EIP-712 encoding for a
 * struct array, so viem's `hashTypedData` produces it without manual encoding.
 */
function allowanceTypes(
    primaryType: "PermitSingle" | "PermitBatch",
): Record<string, TypedDataParameter[]> {
    const details = primaryType === "PermitBatch" ? "PermitDetails[]" : "PermitDetails";
    return {
        [primaryType]: [
            { name: "details", type: details },
            { name: "spender", type: "address" },
            { name: "sigDeadline", type: "uint256" },
        ],
        PermitDetails: PERMIT_DETAILS,
    };
}

/** What both allowance signers take; they differ only in the permit struct. */
interface AllowanceSignArgs<P> {
    signer: EthSigner;
    chainId: bigint;
    permit: P;
    /** Optional Permit2 contract override; defaults to canonical CREATE2. */
    permit2Address?: string;
}

/** @internal */
export interface SignPermit2AllowanceArgs extends AllowanceSignArgs<PermitSingle> {}

/** @internal */
export interface SignPermit2AllowanceBatchArgs extends AllowanceSignArgs<PermitBatch> {}

/**
 * Sign a Permit2 `PermitSingle` for AllowanceTransfer-mode deposits. The
 * resulting `(permit, signature)` pair is submitted on-chain via
 * `IAllowanceTransfer.permit(owner, permitSingle, signature)` once; later
 * deposits within the window pull via `transferFrom` without a signature.
 *
 * @internal
 */
export async function signPermit2Allowance(
    args: SignPermit2AllowanceArgs,
): Promise<{ permit: PermitSingle; signature: string }> {
    return signAllowanceStruct(args, "PermitSingle");
}

/**
 * Sign a Permit2 `PermitBatch`, the N-token counterpart of
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
    return signAllowanceStruct(args, "PermitBatch");
}

/** Shared body of both allowance signers: bind to the Permit2 domain, sign the struct, return the pair. */
async function signAllowanceStruct<P>(
    args: AllowanceSignArgs<P>,
    primaryType: "PermitSingle" | "PermitBatch",
): Promise<{ permit: P; signature: string }> {
    const signature = await signPermit(() =>
        args.signer.signTypedData(
            permit2Domain(args.chainId, args.permit2Address),
            allowanceTypes(primaryType),
            primaryType,
            args.permit as unknown as Record<string, unknown>,
        ),
    );
    return { permit: args.permit, signature };
}
