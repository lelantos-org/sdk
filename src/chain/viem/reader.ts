// viem-based `ChainReader`: the read-only half of the adapter.
//
// `ViemChainAdapter` extends this class and adds only the members that sign or
// broadcast. This class covers what a wallet without an EVM key can do: resolve
// the registry, follow the tree, read balances and wait on receipts. A shielded
// spend needs nothing more, since the circuit authorises it and the relayer
// puts it on chain.

import { createPublicClient, http, type PublicClient } from "viem";
import type { AssetId, EvmAddress, Hex32, TokenAmount } from "../../core/brand.js";
import { randomU256 } from "../../core/random.js";
import type { Field } from "../../crypto/index.js";
import { PERMIT2_ADDRESS } from "../../protocol/deposit-request.js";
import type { ChainReader } from "../port.js";
import type {
    AssetEntry,
    DepositEscrowedRecord,
    EscrowedDepositView,
    TokenMeta,
    TxLog,
} from "../types.js";
import { addr, type ViemReadCtx } from "./ctx.js";
import { chainCall } from "./errors.js";
import * as permit2 from "./permit2.js";
import * as reads from "./reads.js";
import * as token from "./token.js";

/**
 * Calls per JSON-RPC batch.
 *
 * Must stay at or below the read proxy's `max_batch` of 100. viem defaults to
 * 1000, which a page issuing many concurrent reads would exceed and receive a
 * 413. The two are deployed independently; only this margin keeps them in step.
 */
const RPC_BATCH_SIZE = 20;

/**
 * Per-request deadline. Above viem's 10s default; see the transport below.
 *
 * `retryCount` and `retryDelay` stay at viem's defaults. Layering
 * `services/http/client.ts`'s retries here would stack three on three and turn one logical
 * read into nine upstream attempts.
 */
const RPC_TIMEOUT_MS = 15_000;

export interface ViemChainReaderOpts {
    rpcUrl: string;
    maspAddress: string;
    permit2Address?: string | undefined;
    /**
     * `NativeAdapter` deployed alongside the pool. Required for native-coin
     * deposits and unshields: MASP is ERC-20 only, so without it those paths
     * have no entry point and the adapter reports them as unsupported.
     */
    nativeAdapterAddress?: string | undefined;
    chainId?: bigint | undefined;
    /**
     * Replaces `fetch` for RPC traffic, mirroring `HttpOptions.fetch`.
     *
     * Used to instrument or redirect reads in tests. To replace the whole
     * transport, pass a pre-built `chain` adapter to `connect()` instead.
     */
    fetch?: typeof fetch | undefined;
    /**
     * How long viem may answer `eth_blockNumber` from its cache, in ms. Default `0`: every
     * `blockNumber()` reads the chain.
     *
     * viem's own default (4s) lets a spend's cooldown check and a consolidation wait act on a stale
     * tip. Raise it only where read volume matters more than freshness.
     */
    cacheTimeMs?: number | undefined;
}

export class ViemChainReader implements ChainReader {
    readonly publicClient: PublicClient;
    protected readonly readCtx: ViemReadCtx;
    protected readonly _maspAddress: EvmAddress;
    protected readonly _permit2Address: EvmAddress;
    protected readonly _nativeAdapterAddress?: EvmAddress | undefined;
    private readonly chainIdOverride?: bigint | undefined;
    private cachedChainId?: bigint;

    constructor(opts: ViemChainReaderOpts) {
        this.publicClient = createPublicClient({
            // Block and tree freshness checks read the tip; see `cacheTimeMs`.
            cacheTime: opts.cacheTimeMs ?? 0,
            transport: http(opts.rpcUrl, {
                // Batches only calls that are already concurrent, so a lone
                // read pays no added latency. `wait: 8` would also catch
                // sequentially-awaited pairs, at the cost of taxing every
                // single-call read.
                batch: { wait: 0, batchSize: RPC_BATCH_SIZE },
                // Above viem's 10s default, so a slow or rate-limited endpoint
                // surfaces its own 429/502, which viem retries honouring
                // `Retry-After`, rather than the client aborting first with an
                // opaque transport failure.
                timeout: RPC_TIMEOUT_MS,
                ...(opts.fetch ? { fetchFn: opts.fetch } : {}),
            }),
        });
        this._maspAddress = addr(opts.maspAddress);
        this._permit2Address = addr(opts.permit2Address ?? PERMIT2_ADDRESS);
        this._nativeAdapterAddress = opts.nativeAdapterAddress
            ? addr(opts.nativeAdapterAddress)
            : undefined;
        this.chainIdOverride = opts.chainId;

        this.readCtx = {
            publicClient: this.publicClient,
            maspAddress: this._maspAddress,
            permit2Address: this._permit2Address,
            nativeAdapterAddress: this._nativeAdapterAddress,
            chainId: () => this.chainId(),
        };
    }

    // ── reads ────────────────────────────────────────────────────────────
    async chainId(): Promise<bigint> {
        if (this.chainIdOverride !== undefined) return this.chainIdOverride;
        if (this.cachedChainId !== undefined) return this.cachedChainId;
        this.cachedChainId = BigInt(
            await chainCall("chainId", () => this.publicClient.getChainId()),
        );
        return this.cachedChainId;
    }

    async blockNumber(): Promise<number> {
        return Number(await chainCall("blockNumber", () => this.publicClient.getBlockNumber()));
    }

    /** The registry entry with its yield fields. */
    async fetchAsset(id: AssetId): Promise<AssetEntry> {
        return chainCall("fetchAsset", async () => {
            const entry = await reads.fetchAsset(this.readCtx, id);
            return { ...entry, ...(await reads.fetchAssetYield(this.readCtx, id)) };
        });
    }
    getEscrowed(id: bigint): Promise<EscrowedDepositView | null> {
        return chainCall("getEscrowed", () => reads.getEscrowed(this.readCtx, id));
    }
    fetchDepositEscrowed(id: bigint, fromBlock?: bigint): Promise<DepositEscrowedRecord | null> {
        return chainCall("fetchDepositEscrowed", () =>
            reads.fetchDepositEscrowed(this.readCtx, id, fromBlock),
        );
    }
    cancelDelay(): Promise<number> {
        return chainCall("cancelDelay", () => reads.cancelDelay(this.readCtx));
    }
    isKnownRoot(root: Field): Promise<boolean> {
        return chainCall("isKnownRoot", () => reads.isKnownRoot(this.readCtx, root));
    }

    // ── tokens ───────────────────────────────────────────────────────────
    tokenMeta(a: EvmAddress): Promise<TokenMeta> {
        return chainCall("tokenMeta", () => token.tokenMeta(this.readCtx, a));
    }
    tokenBalanceOf(a: EvmAddress, account: EvmAddress): Promise<TokenAmount> {
        return chainCall("tokenBalanceOf", () => token.tokenBalanceOf(this.readCtx, a, account));
    }
    tokenAllowance(a: EvmAddress, owner: EvmAddress, spender: EvmAddress): Promise<TokenAmount> {
        return chainCall("tokenAllowance", () =>
            token.tokenAllowance(this.readCtx, a, owner, spender),
        );
    }
    waitTxReceipt(
        txHash: Hex32,
        confirmations?: number,
    ): Promise<{ blockNumber: number; status: number }> {
        return chainCall("waitTxReceipt", () =>
            token.waitTxReceipt(this.readCtx, txHash, confirmations),
        );
    }
    txReceiptLogs(txHash: Hex32): Promise<readonly TxLog[]> {
        return chainCall("txReceiptLogs", () => token.txReceiptLogs(this.readCtx, txHash));
    }
    nativeBalance(account: EvmAddress): Promise<bigint> {
        return chainCall("nativeBalance", () => token.nativeBalance(this.readCtx, account));
    }

    // ── permit2 (reads) ──────────────────────────────────────────────────
    permit2Allowance(
        tok: EvmAddress,
        owner: EvmAddress,
        spender: EvmAddress,
    ): Promise<{ amount: TokenAmount; expiration: number; nonce: number }> {
        return chainCall("permit2Allowance", () =>
            permit2.permit2Allowance(this.readCtx, tok, owner, spender),
        );
    }
    /** Permit2 nonces are caller-chosen and unordered, so a random u256 suffices. */
    async permit2Nonce(): Promise<bigint> {
        return randomU256();
    }
    permit2Address(): EvmAddress {
        return this._permit2Address;
    }

    // ── addresses ────────────────────────────────────────────────────────
    async maspAddress(): Promise<EvmAddress> {
        return this._maspAddress;
    }
    /** `undefined` when no `NativeAdapter` is configured for this chain. */
    nativeAdapterAddress(): EvmAddress | undefined {
        return this._nativeAdapterAddress;
    }
}
