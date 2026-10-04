// Data shapes the chain adapter exchanges with the rest of the SDK. The port
// itself is in `./port.ts`.

import type { AssetId, EvmAddress, Hex32, TokenAmount } from "../core/brand.js";
import type { YieldRate } from "../protocol/units.js";

export interface AssetEntry {
    token: EvmAddress;
    /** Multiplier from circuit units to ERC-20 base units. */
    scale: bigint;
    /**
     * Set by the pool owner. A disabled asset blocks new deposits; existing
     * notes and escrows remain spendable.
     */
    disabled: boolean;
    /**
     * Protocol fee on the shield leg, in basis points. Per-asset, and
     * independent of {@link AssetEntry.withdrawBps}.
     */
    depositBps: bigint;
    /** Protocol fee on the unshield leg, in basis points. */
    withdrawBps: bigint;
    /**
     * Pool-managed yield index, RAY-scaled. `RAY` for a plain asset, at which
     * every conversion reduces to plain `scale` arithmetic.
     */
    index: bigint;
    /**
     * Whether the pool routes this asset's balance to a yield venue. Changes
     * which unit space the withdraw fee is charged in, so it is not derivable
     * from `index` alone: a freshly enabled asset sits at exactly `RAY`.
     */
    yieldEnabled: boolean;
    /**
     * The pool's own `{ gross, supply }` ratio, for sizing a payment.
     *
     * Present only for a yield asset on an adapter that reads it. {@link index}
     * is floored on chain, so converting a charge through it can land below
     * what the contract takes, and a Permit2 `maxTotal` signed off that figure
     * is refused; the pool itself divides by this pair. Absent on a plain asset,
     * where `scale` alone is exact.
     */
    rate?: YieldRate;
}

export interface Permit2SignArgs {
    /** ERC-20 being pulled into escrow. */
    token: EvmAddress;
    /**
     * Ceiling on the deposit token's pull, in its base units: `inAmt + fee`,
     * plus the relayer note when it is paid in the same asset. Bound into the
     * sig as that token's `permitted.amount`.
     */
    maxTotal: TokenAmount;
    /**
     * The fee token, when the relayer note is paid in an asset other than the
     * deposit's. Set together with {@link maxFee}; the adapter then signs a
     * `PermitBatchWitnessTransferFrom` over `[token: maxTotal, feeToken:
     * maxFee]` instead of the single-token permit.
     *
     * May equal `token`: a plain id and a yield id can share one ERC-20, and
     * the pool still pulls them as two entries.
     */
    feeToken?: EvmAddress | undefined;
    /** Ceiling on the fee token's pull, in its base units. Requires {@link feeToken}. */
    maxFee?: TokenAmount | undefined;
    /** Unix-seconds expiry. */
    deadline: bigint;
    /**
     * `keccak256(abi.encode(DepositRequest, aux, feeAux))`. Binds the sig to a
     * specific deposit.
     */
    piHash: Hex32;
    /** Fresh value; Permit2 uses an unordered bitmap. */
    nonce: bigint;
}

/**
 * `MASP.escrowed(id)` view: the digest only. The fields folded into it are
 * reconstructed from the `DepositEscrowed` log.
 */
export interface EscrowedDepositView {
    digest: Hex32;
}

/**
 * Preimage fields for `cancelDeposit`. The escrow row keeps only a digest, so
 * every field is passed back in and checked against it. Cache them:
 * `escrowed()` returns none of them.
 *
 * All but `submittedAt` come from the `DepositEscrowed` log. `submittedAt` is
 * the EVM's `block.number`, which the log does not carry on Arbitrum, so
 * `fetchDepositEscrowed` resolves it rather than reusing `log.blockNumber`.
 */
export interface CancelDepositInputs {
    publicIn: bigint;
    /** The depositor note's `inner`, as the request escrowed it. */
    inner: Hex32;
    publicAssetId: AssetId;
    feeBpsAtSubmit: number;
    payer: EvmAddress;
    submittedAt: number;
    /** The relayer's fee leaf value. */
    feeIn: bigint;
    /**
     * The fee leaf's asset, as the request named it: `0` for a zero-value
     * note. Decides whether the relayer's share refunds with the principal or
     * separately in its own token.
     */
    feeAssetId: AssetId;
    feeInner: Hex32;
    /**
     * The escrow's refund cap, {@link DepositEscrowedRecord.pulled}. Any value
     * but the event's reverts `DigestMismatch`.
     */
    pulled: bigint;
}

/**
 * What `cancelDeposit` refunded, decoded from the pool's `DepositCanceled` log.
 *
 * A native cancel reports the pool's figures too: the adapter is the pool's
 * payer and forwards the coin.
 */
export interface CancelDepositReceipt {
    txHash: Hex32;
    /**
     * Refunded in the deposit asset's token, in its base units: principal and
     * protocol fee, plus the relayer's share when it was paid in that asset.
     */
    refunded: bigint;
    /** The fee leaf's asset; `0` for a zero-value note. */
    feeAssetId: AssetId;
    /**
     * Refunded in `feeAssetId`'s token, in its base units. Nonzero only when the
     * relayer note was paid in another asset.
     */
    feeRefunded: bigint;
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
    /**
     * The depositor note's `inner`. The leaf is not in the event: it is
     * `Poseidon(TAG_CM, publicAssetId · 2^64 + publicIn, inner)`.
     */
    inner: Hex32;
    /** The relayer's fee leaf value, in circuit units of `feeAssetId`. */
    feeIn: bigint;
    /** The fee leaf's asset; `0` exactly when `feeIn` is zero. */
    feeAssetId: AssetId;
    /** The fee note's `inner`; its leaf is built from `feeAssetId` and `feeIn` likewise. */
    feeInner: Hex32;
    /**
     * The escrow's refund cap: for a yield asset the underlying the pool pulled
     * at submit, in the deposit asset's base units, which is the most a cancel
     * returns. Exactly `0n` for a plain asset.
     */
    pulled: bigint;
    /**
     * Solidity's `block.number` at escrow time: the value folded into the
     * on-chain digest.
     *
     * Not always the block number of the `DepositEscrowed` log. On Arbitrum the
     * EVM reports the L1 height while the log carries the L2 height, so this is
     * resolved via the block's `l1BlockNumber` (see `viem/evm-block.ts`).
     */
    submittedAt: number;
}

/**
 * A mined deposit, read off its receipt. `escrowed` is what `cancelDeposit`
 * resupplies, so a caller can cancel without a log query.
 */
export interface DepositSubmitted {
    txHash: Hex32;
    /** The pool's escrow id, from `DepositEscrowed`. */
    depositId: bigint;
    /** The receipt's block number: the chain's own height (L2 on a rollup). */
    blockNumber: number;
    /** The `DepositEscrowed` payload, `submittedAt` resolved to the EVM's `block.number`. */
    escrowed: DepositEscrowedRecord;
}

/**
 * One output as the pool published it in a `NotePayload` log: what anyone can
 * read about it from the chain.
 */
export interface PublishedNote {
    cm: Hex32;
    /** The output's ECDH ephemeral public key. */
    ephPub: [bigint, bigint];
    /** Wire ciphertext: 2B clueBits prefix, then the ChaCha body. */
    ciphertext: Uint8Array;
}

/**
 * One log of a transaction receipt, reduced to what locating an operation in
 * it needs. `topics[0]` is the event selector.
 */
export interface TxLog {
    /** Emitting contract. */
    address: EvmAddress;
    topics: readonly Hex32[];
}

/** ERC20 display metadata. */
export interface TokenMeta {
    symbol: string;
    decimals: number;
}
