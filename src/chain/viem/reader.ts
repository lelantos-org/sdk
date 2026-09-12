// viem-based `ChainReader`: the read-only half of the adapter.
//
// Split out of `ViemChainAdapter` rather than duplicated from it — the adapter
// extends this class and adds only the members that sign or broadcast. What is
// left here is exactly what a wallet with no EVM key can still do: resolve the
// registry, follow the tree, read balances and wait on receipts. A shielded
// spend needs nothing more, since the circuit authorises it and the relayer
// puts it on chain.

import { createPublicClient, http, type PublicClient } from "viem";
import type { AssetId, EvmAddress, Hex32, TokenAmount } from "../../core/brand.js";
import type { Field } from "../../crypto/index.js";
import { PERMIT2_ADDRESS } from "../../protocol/deposit-request.js";
import type { ChainReader } from "../port.js";
import type {
    AssetEntry,
    DepositEscrowedRecord,
    EscrowedDepositView,
    TokenMeta,
} from "../types.js";
import { addr, type ViemReadCtx } from "./ctx.js";
import * as permit2 from "./permit2.js";
import * as reads from "./reads.js";
import * as token from "./token.js";

/**
 * Calls per JSON-RPC batch.
 *
 * Must stay at or below the read proxy's own `max_batch`, which is 100. viem
 * defaults to 1000, which a page issuing many concurrent reads would exceed and
 * be answered with a 413. The two are independently deployed and nothing keeps
 * them in step but this margin.
 */
const RPC_BATCH_SIZE = 20;

/**
 * Per-request deadline. Above viem's 10s default; see the transport below.
 *
 * `retryCount` and `retryDelay` are deliberately left at viem's defaults.
 * Layering `core/http.ts`'s retries here would stack three on three and turn
 * one logical read into nine upstream attempts.
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
     * Replaces `fetch` for RPC traffic, mirroring `WalletConfig.fetchImpl`.
     *
     * The seam for instrumenting or redirecting reads in tests. Callers needing
     * to replace the whole transport pass a pre-built `chain` adapter to
     * `connect()` instead.
     */
    fetchImpl?: typeof fetch | undefined;
}

export class ViemChainReader implements ChainReader {
    readonly publicClient: PublicClient;
    protected readonly readCtx: ViemReadCtx;
    protected readonly _maspAddress: EvmAddress;
    protected readonly _permit2Address: EvmAddress;
    protected readonly _nativeAdapterAddress?: EvmAddress | undefined;
    private readonly chainIdOverride?: bigint | undefined;
    private cachedChainId?: bigint;
    /**
     * Whether this pool answers `yieldState`, remembered after the first
     * `fetchAsset`.
     *
     * Probing is the read itself: a pool without the mixin reverts, and that
     * costs an eth_call per asset fetched. One `false` here is enough to stop
     * paying it — the selector cannot appear on a pool that has already been
     * observed not to have it, since the code at an address does not change.
     */
    private poolYields?: boolean;

    constructor(opts: ViemChainReaderOpts) {
        this.publicClient = createPublicClient({
            transport: http(opts.rpcUrl, {
                // Batches only calls that are already concurrent, so a lone
                // read pays no added latency. `wait: 8` would also catch
                // sequentially-awaited pairs, at the cost of taxing every
                // single-call read.
                batch: { wait: 0, batchSize: RPC_BATCH_SIZE },
                // Above viem's 10s default, so a slow or rate-limited endpoint
                // surfaces its own 429/502 — which viem retries correctly,
                // honouring `Retry-After` — rather than the client aborting
                // first and reporting an opaque transport failure.
                timeout: RPC_TIMEOUT_MS,
                ...(opts.fetchImpl ? { fetchFn: opts.fetchImpl } : {}),
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
        this.cachedChainId = BigInt(await this.publicClient.getChainId());
        return this.cachedChainId;
    }

    async blockNumber(): Promise<number> {
        return Number(await this.publicClient.getBlockNumber());
    }

    /**
     * The registry entry, with the yield fields folded in when the pool has
     * them.
     *
     * Composed here rather than inside `reads.fetchAsset` so that the
     * "does this pool yield at all" answer can be remembered across calls:
     * that is per-pool state, and the pool is what this class is.
     */
    async fetchAsset(id: AssetId): Promise<AssetEntry> {
        const entry = await reads.fetchAsset(this.readCtx, id);
        if (this.poolYields === false) return entry;

        const y = await reads.fetchAssetYield(this.readCtx, id);
        this.poolYields = y !== undefined;
        return y ? { ...entry, ...y } : entry;
    }
    getEscrowed(id: bigint): Promise<EscrowedDepositView | null> {
        return reads.getEscrowed(this.readCtx, id);
    }
    fetchDepositEscrowed(id: bigint, fromBlock?: bigint): Promise<DepositEscrowedRecord | null> {
        return reads.fetchDepositEscrowed(this.readCtx, id, fromBlock);
    }
    cancelDelay(): Promise<number> {
        return reads.cancelDelay(this.readCtx);
    }
    isKnownRoot(root: Field): Promise<boolean> {
        return reads.isKnownRoot(this.readCtx, root);
    }

    // ── tokens ───────────────────────────────────────────────────────────
    tokenMeta(a: EvmAddress): Promise<TokenMeta> {
        return token.tokenMeta(this.readCtx, a);
    }
    tokenBalanceOf(a: EvmAddress, account: EvmAddress): Promise<TokenAmount> {
        return token.tokenBalanceOf(this.readCtx, a, account);
    }
    tokenAllowance(a: EvmAddress, owner: EvmAddress, spender: EvmAddress): Promise<TokenAmount> {
        return token.tokenAllowance(this.readCtx, a, owner, spender);
    }
    waitTxReceipt(
        txHash: Hex32,
        confirmations?: number,
    ): Promise<{ blockNumber: number; status: number }> {
        return token.waitTxReceipt(this.readCtx, txHash, confirmations);
    }
    nativeBalance(account: EvmAddress): Promise<bigint> {
        return token.nativeBalance(this.readCtx, account);
    }

    // ── permit2 (reads) ──────────────────────────────────────────────────
    permit2Allowance(
        tok: EvmAddress,
        owner: EvmAddress,
        spender: EvmAddress,
    ): Promise<{ amount: TokenAmount; expiration: number; nonce: number }> {
        return permit2.permit2Allowance(this.readCtx, tok, owner, spender);
    }
    permit2Nonce(): Promise<bigint> {
        return permit2.permit2Nonce();
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
