// Data shapes the chain adapter exchanges with the rest of the SDK. Declared
// apart from the port in `./port.ts`.

import type { AssetId, EvmAddress, Hex32, TokenAmount } from "../core/brand.js";

export interface AssetEntry {
    token: EvmAddress;
    /** circuit-units → ERC20-base-units multiplier. */
    scale: bigint;
    /**
     * Owner-flipped flag. Disabled assets block new deposits; existing
     * notes / escrows remain spendable.
     */
    disabled: boolean;
}

export interface Permit2SignArgs {
    /** ERC-20 being pulled into escrow. */
    token: EvmAddress;
    /**
     * Ceiling on `inAmt + fee` in token base units. Bound into the sig
     * as `permitted.amount`.
     */
    maxTotal: TokenAmount;
    /** Unix-seconds expiry. */
    deadline: bigint;
    /**
     * `keccak256(abi.encode(DepositRequest, aux))`. Binds the sig to a
     * specific deposit.
     */
    piHash: Hex32;
    /** Fresh value; Permit2 uses an unordered bitmap. */
    nonce: bigint;
}

/**
 * `MASP.escrowed(id)` view — now the digest and nothing else. The row used to
 * carry `payer`, `submittedAt`, `publicAssetId` and `feeBpsAtSubmit`; those are
 * folded into the digest and must be reconstructed from the `DepositEscrowed`
 * log, which is also what `cancelDeposit` now takes back as arguments.
 */
export interface EscrowedDepositView {
    digest: Hex32;
}

/**
 * Preimage fields for `cancelDeposit`. The escrow row keeps only
 * `keccak(request)`, so every field the contract once read from storage is now
 * passed back in and checked against that digest — including `publicAssetId`,
 * `feeBpsAtSubmit`, `payer` and `submittedAt`. All of them come off the
 * `DepositEscrowed` log; cache it, because `escrowed()` no longer returns them.
 */
export interface CancelDepositInputs {
    publicIn: bigint;
    cm: Hex32;
    cvDep: [bigint, bigint];
    publicAssetId: AssetId;
    feeBpsAtSubmit: number;
    payer: EvmAddress;
    submittedAt: number;
}

/**
 * Decoded `DepositEscrowed` event. Cache to feed `cancelDeposit` and
 * reconstruct fields absent from `escrowed()` storage.
 */
export interface DepositEscrowedRecord {
    id: bigint;
    payer: EvmAddress;
    recipient: EvmAddress;
    publicAssetId: AssetId;
    publicIn: bigint;
    feeBpsAtSubmit: number;
    cm: Hex32;
    cvDep: [bigint, bigint];
    rcv: bigint;
    /** Block number of the deposit that created this escrow. */
    submittedAt: number;
}

/** ERC20 display metadata. */
export interface TokenMeta {
    symbol: string;
    decimals: number;
}
