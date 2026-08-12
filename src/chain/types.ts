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
 * `MASP.escrowed(id)` view — now the digest and nothing else. The row used to
 * carry `payer`, `submittedAt`, `publicAssetId` and `feeBpsAtSubmit`; those are
 * folded into the digest and must be reconstructed from the `IntentEscrowed`
 * log, which is also what `cancelIntent` now takes back as arguments.
 */
export interface EscrowedIntentView {
    digest: Hex32;
}

/**
 * Preimage fields for `cancelIntent`. The escrow row keeps only
 * `keccak(intent)`, so every field the contract once read from storage is now
 * passed back in and checked against that digest — including `publicAssetId`,
 * `feeBpsAtSubmit`, `payer` and `submittedAt`. All of them come off the
 * `IntentEscrowed` log; cache it, because `escrowed()` no longer returns them.
 */
export interface CancelIntentInputs {
    publicIn: bigint;
    cm: Hex32;
    cvDep: [bigint, bigint];
    publicAssetId: AssetId;
    feeBpsAtSubmit: number;
    payer: EvmAddress;
    submittedAt: number;
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
    cm: Hex32;
    cvDep: [bigint, bigint];
    rcv: bigint;
    /** Block number of the `submitIntent` that escrowed this intent. */
    submittedAt: number;
}

/** ERC20 display metadata. */
export interface TokenMeta {
    symbol: string;
    decimals: number;
}
