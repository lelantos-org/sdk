// Relayer wire contract: response shapes.

import type { Hex32 } from "../core/brand.js";

/** @internal */
export interface RelayerSubmitResponse {
    /** Tx hash once mined. Relayer awaits inclusion before responding. */
    txHash: Hex32;
}

/**
 * Terms on which a relayer accepts a shielded fee, as published by `/chains`.
 *
 * Presence means required: a chain that returns this object refuses (402) any spend or swap
 * without a fee output addressed to {@link address}; a chain that omits it charges nothing.
 *
 * Terms only: the amount moves with the gas price and an oracle rate, and `/v1/spend/estimate`
 * returns the live figure.
 *
 * @internal
 */
export interface ShieldedFeeTerms {
    /** bech32m address to address the fee note to. */
    address: string;
    /**
     * How far below the relayer's submit-time quote a payment may fall and still be accepted:
     * the drift allowed between quoting and submitting.
     */
    graceBps: number;
    /** Markup over raw gas cost, already included in every quoted amount. */
    markupBps: number;
    /**
     * Assets accepted as a fee. A spend is built in a single asset, so one absent from here
     * cannot pay for its own transfer and the relayer will not move it. Each entry carries the
     * `scale` needed to size a fee note.
     */
    tokens: ChainToken[];
}

/**
 * One chain, as `/chains` describes it: the registry a client boots from.
 *
 * A deployment omits the optional fields it has not described, and a client falls back to its
 * own defaults.
 *
 * @internal
 */
export interface ChainInfo {
    chainId: number;
    committedCount: number;
    currentRootHex: string;
    /** EIP-55 checksummed MASP pool. */
    maspAddress: string;
    /**
     * True once a submission's outcome could not be determined. The relayer
     * rejects work on this chain until it restarts.
     */
    desynced: boolean;
    /**
     * EIP-55 checksummed submitter, to bind into the SNARK as `pi.relayer`.
     * The relayer's `Bundler` contract where it bundles, so not necessarily the
     * EOA that signs its transactions.
     */
    relayerAddress: string;
    /**
     * EIP-55 checksummed account the relayer offers as a swap's `refundTo`
     * when the wallet has no EVM account of its own. Distinct from
     * {@link relayerAddress}: the `Bundler` cannot move a refunded token, so a
     * cancelled escrow refunded there is stuck. Absent when the relayer has no
     * refund account configured.
     */
    refundAddress?: string;
    nativeAdapterAddress?: string;
    swapWrapperAddress?: string;
    genericCallWrapperAddress?: string;
    chainName?: string;
    /**
     * Browser-reachable RPC; not the relayer's own endpoint.
     *
     * Offered to the user's wallet via `wallet_addEthereumChain`, so it must be a general-purpose
     * endpoint that serves writes, `eth_subscribe` and background polling; a read-only proxy
     * there would break the wallet. See {@link readRpcUrl}.
     */
    rpcUrl?: string;
    /**
     * Read-only RPC for the SDK's own `eth_call`/`eth_getLogs` traffic. Consumers read
     * `readRpcUrl ?? rpcUrl`.
     */
    readRpcUrl?: string;
    treeDepth?: number;
    permit2Address?: string;
    explorerUrl?: string;
    /**
     * Registered assets, lowest id first. Empty means "the indexer has not
     * caught up", never "this chain supports nothing".
     */
    tokens: ChainToken[];
    shieldedFee?: ShieldedFeeTerms;
}

/** One asset a wallet may hold on a chain. @internal */
export interface ChainToken {
    /** MASP asset id — what goes in a note. */
    assetId: number;
    /** 0x-prefixed ERC-20 address. */
    token: string;
    /** `baseUnits = circuitUnits * scale`. Decimal string; exceeds `u53`. */
    scale: string;
    /** Absent until the indexer has read it. Unknown, never assume 18. */
    decimals?: number;
    /** Absent until read, or where the token implements no `symbol()`. */
    symbol?: string;
    /**
     * Protocol fee on a shield of this asset, in bps. Absent until the relayer has indexed an
     * `AssetFeeSet` for it, which means unknown, not zero: the registry falls back to reading
     * the pool.
     */
    depositBps?: number;
    /** Protocol fee on an unshield of this asset, in bps. See `depositBps`. */
    withdrawBps?: number;
    /**
     * Present when the pool routes this asset's balance to a yield venue.
     *
     * Absent means plain custody, where a circuit unit is worth `scale` base units, or a yield
     * asset the relayer has not priced yet: `scale` is not a safe fallback there, as it is off
     * by whatever the venue has earned.
     */
    yieldState?: YieldStateInfo;
}

/**
 * What a yield asset is currently worth, and under what terms.
 *
 * Decimal strings throughout; every one of these exceeds `u53`.
 */
export interface YieldStateInfo {
    /** Venue holding the position. Bound once at registration and immutable. */
    venue: string;
    /** Venue position plus the pool's idle balance, in token base units. */
    gross: string;
    /** Units outstanding: note holders plus the treasury's unswept fee. */
    supply: string;
    /**
     * `gross * RAY / (supply * scale)`, for display.
     *
     * Floored on chain, so it must not be used to size a payment; convert with
     * `gross` and `supply`, as the pool does.
     */
    index: string;
    /**
     * The venue is not being supplied. Existing backing is unaffected: the
     * asset degrades to zero-yield custody, still fully backed.
     */
    halted: boolean;
}

/** @internal */
export interface ChainsResponse {
    chains: ChainInfo[];
}

/**
 * One accepted fee token, priced.
 *
 * `assetId`, `scale` and `circuitAmount` arrive together or not at all: they are absent when the
 * relayer cannot map this token to a registered asset, so no fee note can be built for it.
 * `amount` is still meaningful for display.
 *
 * @internal
 */
export interface RelayerFeeQuote {
    tokenSymbol: string;
    /** 0x-prefixed ERC-20 address. */
    tokenAddress: string;
    decimals: number;
    /** Base-unit amount, decimal string. */
    amount: string;
    assetId?: number;
    scale?: string;
    /**
     * {@link amount} rounded up to a whole circuit unit: the exact `value` to put in the fee
     * note. Rounding down would underpay by up to one unit and be refused.
     */
    circuitAmount?: string;
}

/** @internal */
export interface EstimateResponse {
    gasUsed: number;
    effectiveGasPriceWei: string;
    totalNativeWei: string;
    /** Per-chain markup applied. bps: 1000 = 10%. */
    markupBps: number;
    /** Unix seconds (relayer clock) when the quote was produced. */
    quotedAt: number;
    fees: RelayerFeeQuote[];
    /**
     * Where to send the fee note. Absent means this chain charges nothing and
     * a spend without a fee output is still relayed.
     */
    shieldedFeeAddress?: string;
}
