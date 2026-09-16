// Uniswap Permit2 witness signing for MASP deposits.
//
// Flow: build DepositRequest + AuxValidation.Output[2], hash via abi.encode +
// keccak (matches MASP.deposit), wrap piHash in the EIP-712 `MASPDeposit`
// witness, and sign the outer Permit2 typed data: `PermitWitnessTransferFrom`
// when the relayer note is in the deposit's asset, and
// `PermitBatchWitnessTransferFrom` over `[deposit token, fee token]` when it is
// not.
//
// Witness type-string MUST match MASP.DEPOSIT_WITNESS_TYPE_STRING. Both
// primary types share it: Permit2 prefixes its own stub.

import type { TypedDataParameter } from "viem";
import { InvalidArgumentError } from "../errors/config.js";
import type { EthSigner } from "../keys/signer.js";
import type { Permit2Sig } from "../protocol/deposit-request.js";
import { permit2Domain, signPermit } from "./common.js";

/**
 * EIP-712 type table for Permit2's witness transfer with the `MASPDeposit` witness: the single-token
 * form, or its two-token batch counterpart, which differ only in whether `permitted` is an array.
 * Permit2 prefixes its own stub to MASP's witness type string, so the other members are identical.
 *
 * For the batch, Permit2 hashes `permitted` as `keccak256(abi.encodePacked(perEntryHashes))`
 * (`PermitHash.hashWithWitness(PermitBatchTransferFrom, ...)`), which is the EIP-712 encoding of a
 * struct array, so viem's typed-data hashing matches it.
 */
function witnessTypes(
    primaryType: "PermitWitnessTransferFrom" | "PermitBatchWitnessTransferFrom",
): Record<string, TypedDataParameter[]> {
    const permitted =
        primaryType === "PermitBatchWitnessTransferFrom"
            ? "TokenPermissions[]"
            : "TokenPermissions";
    return {
        [primaryType]: [
            { name: "permitted", type: permitted },
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
}

/** @internal */
export interface SignPermit2Args {
    signer: EthSigner;
    chainId: bigint;
    /** MASP contract address (the Permit2 spender). */
    spender: string;
    /** ERC-20 being pulled into escrow. */
    token: string;
    /**
     * Caller's ceiling on `token`'s pull, in its base units: `inAmt + fee`,
     * plus the relayer note when it is paid in the deposit's asset.
     */
    maxTotal: bigint;
    /**
     * The relayer note's token, when it is paid in another asset. With
     * {@link maxFee} this signs `PermitBatchWitnessTransferFrom` over
     * `[token: maxTotal, feeToken: maxFee]`, in that order; without, the
     * single-token `PermitWitnessTransferFrom`.
     */
    feeToken?: string | undefined;
    /** Ceiling on `feeToken`'s pull, in its base units. Set with {@link feeToken}. */
    maxFee?: bigint | undefined;
    nonce: bigint;
    /** Unix-seconds Permit2 expiry. */
    deadline: bigint;
    /** `keccak256(abi.encode(DepositRequest, aux, feeAux))`. */
    piHash: string;
    /**
     * Optional override for the Permit2 contract address (non-standard
     * deployments). Defaults to the canonical deterministic CREATE2 address.
     */
    permit2Address?: string;
}

/**
 * Sign the Permit2 witness transfer `MASP.deposit` verifies.
 *
 * Single-token unless `feeToken` and `maxFee` are both given, in which case the
 * signature is the batch form the pool checks for a relayer note paid in another
 * asset. Which one to sign follows `isSameFeeAsset`: signing the wrong form
 * reverts on chain as `InvalidSigner`.
 *
 * @throws {InvalidArgumentError} when only one of `feeToken` and `maxFee` is set.
 */
export async function signPermit2Witness(args: SignPermit2Args): Promise<Permit2Sig> {
    const { feeToken, maxFee } = args;
    if ((feeToken === undefined) !== (maxFee === undefined)) {
        throw new InvalidArgumentError(
            "signPermit2Witness: feeToken and maxFee must be set together",
            { argument: feeToken === undefined ? "feeToken" : "maxFee" },
        );
    }
    const principal = { token: args.token, amount: args.maxTotal };
    // Order is binding: the pool builds `[deposit token, fee token]`.
    const [primaryType, permitted] =
        feeToken === undefined || maxFee === undefined
            ? (["PermitWitnessTransferFrom", principal] as const)
            : ([
                  "PermitBatchWitnessTransferFrom",
                  [principal, { token: feeToken, amount: maxFee }],
              ] as const);
    const signature = await signPermit(() =>
        args.signer.signTypedData(
            permit2Domain(args.chainId, args.permit2Address),
            witnessTypes(primaryType),
            primaryType,
            {
                permitted,
                spender: args.spender,
                nonce: args.nonce,
                deadline: args.deadline,
                witness: { piHash: args.piHash },
            },
        ),
    );
    return {
        nonce: args.nonce,
        deadline: args.deadline,
        maxTotal: args.maxTotal,
        // The pool reverts `BadMaxFee` for a nonzero value on the single-token path.
        maxFee: maxFee ?? 0n,
        signature,
    };
}
