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
     * `keccak256(abi.encode(DepositIntent, aux))`. Binds the sig to a
     * specific deposit.
     */
    piHash: Hex32;
    /** Fresh value; Permit2 uses an unordered bitmap. */
    nonce: bigint;
}

/**
 * `MASP.escrowed(id)` view. `cm0/cm1/publicIn` are folded into `digest`;
 * reconstruct via the `IntentEscrowed` log.
 */
export interface EscrowedIntentView {
    digest: Hex32;
    payer: EvmAddress;
    /** block number of submitIntent. */
    submittedAt: number;
    publicAssetId: AssetId;
    feeBpsAtSubmit: number;
}

/**
 * Preimage fields for `cancelIntent`. On-chain digest check binds these
 * to what was escrowed at submit. Sourced from `IntentEscrowedRecord`.
 * `feeBpsAtSubmit` is not needed; the contract reads it from escrow
 * storage.
 */
export interface CancelIntentInputs {
    publicIn: bigint;
    cm0: Hex32;
    cm1: Hex32;
    cvDep0: [bigint, bigint];
    cvDep1: [bigint, bigint];
}

/**
 * Decoded `IntentEscrowed` event. Cache to feed `cancelIntent` and
 * reconstruct fields absent from `escrowed()` storage.
 */
export interface IntentEscrowedRecord {
    id: bigint;
    payer: EvmAddress;
    recipient: EvmAddress;
    publicAssetId: AssetId;
    publicIn: bigint;
    feeBpsAtSubmit: number;
    cm0: Hex32;
    cm1: Hex32;
    cvDep0: [bigint, bigint];
    cvDep1: [bigint, bigint];
    rcvTotal: bigint;
}

/** ERC20 display metadata. */
export interface TokenMeta {
    symbol: string;
    decimals: number;
}
