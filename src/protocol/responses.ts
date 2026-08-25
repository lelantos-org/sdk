// Relayer wire contract: response shapes.

import type { Hex32 } from "../core/brand.js";
import type { Field, Point } from "../crypto/index.js";

/** @internal */
export interface RelayerSubmitResponse {
    /** Tx hash once mined. Relayer awaits inclusion before responding. */
    txHash: Hex32;
}

/** @internal */
export interface RelayerDepositResponse {
    txHash: Hex32;
    /**
     * Deposit id allocated by `MASP.deposit` (== `nextDepositId` at
     * time of the call). Wallet uses this to track escrow lifecycle and
     * for `MASP.cancelDeposit` if the relayer never flushes.
     */
    depositId: bigint;
}

/**
 * Terms on which a relayer accepts a shielded fee, as published by `/chains`.
 *
 * **Presence means required.** A chain that returns this object will refuse
 * (402) any spend or swap that does not carry a fee output addressed to
 * {@link address}; a chain that omits it charges nothing. There is no
 * `required` flag, because a flag could disagree with the object's presence.
 *
 * Terms only — no amount. An amount moves with the gas price and an oracle
 * rate, and `/chains` is a boot registry held behind a 60s cache; ask
 * `/v1/spend/estimate` for the live number.
 *
 * @internal
 */
export interface ShieldedFeeTerms {
    /** bech32m address to address the fee note to. */
    address: string;
    /**
     * How far below the relayer's own submit-time quote a payment may fall and
     * still be accepted. The relayer re-derives the requirement when the spend
     * arrives, so this is the drift allowed between quoting and submitting.
     */
    graceBps: number;
    /** Markup over raw gas cost, already included in every quoted amount. */
    markupBps: number;
    /**
     * Assets accepted as a fee.
     *
     * A spend is built in a single asset, so this doubles as the list of assets
     * the relayer will move at all: one absent from here cannot pay for its own
     * transfer.
     *
     * Repeated in full rather than named by id, so this object carries the
     * `scale` needed to size a note without joining back to
     * {@link ChainInfo.tokens}.
     */
    tokens: ChainToken[];
}

/**
 * One chain, as `/chains` describes it. The relayer is the only service that
 * enumerates every chain, so this is the registry a client boots from.
 *
 * Every field past `chainId` is optional: a deployment that has not described
 * something omits it, and a client falls back to its own defaults rather than
 * to a guess.
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
    /** EIP-55 checksummed relayer signer, to bind into the SNARK. */
    relayerAddress: string;
    nativeAdapterAddress?: string;
    swapWrapperAddress?: string;
    chainName?: string;
    /** Browser-reachable RPC; not the relayer's own endpoint. */
    rpcUrl?: string;
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
}

/** @internal */
export interface ChainsResponse {
    chains: ChainInfo[];
}

/**
 * One accepted fee token, priced.
 *
 * `assetId`, `scale` and `circuitAmount` arrive together or not at all: they
 * are absent when the relayer cannot map this token to a registered asset,
 * which means a fee note cannot be built for it yet. `amount` is still
 * meaningful for display.
 *
 * @internal
 */
export interface FeeQuote {
    tokenSymbol: string;
    /** 0x-prefixed ERC-20 address. */
    tokenAddress: string;
    decimals: number;
    /** Base-unit amount, decimal string. */
    amount: string;
    assetId?: number;
    scale?: string;
    /**
     * {@link amount} rounded **up** to a whole circuit unit — the exact `value`
     * to put in the fee note.
     *
     * Rounded server-side because rounding down would underpay by up to one
     * whole unit and be refused, and because two implementations of the same
     * rounding drift apart.
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
    fees: FeeQuote[];
    /**
     * Where to send the fee note. Absent means this chain charges nothing and
     * a spend without a fee output is still relayed.
     */
    shieldedFeeAddress?: string;
}

/** @internal */
export interface MerkleProofResponse {
    leafIndex: number;
    pathElements: Field[][];
    pathIndices: number[];
    /**
     * Root computed from the path. Caller MUST `isKnownRoot[root]` against
     * the chain before trusting the proof for spending.
     */
    root: Field;
}

/** @internal */
export interface ScannedNote {
    /** Encrypted note (ChaCha20-Poly1305 body + clueBits prefix). */
    ciphertext: Uint8Array;
    clueR: Point;
    ephPub: Point;
    cm: Field;
    leafIndex: number;
}
