// The `ChainAdapter` port and its capability subtypes.
//
// Most members are optional: an adapter implements the deposit paths its
// chain supports. The `supports*` guards below are how callers discover
// which path is available, since the interface alone cannot say.

import type { AssetId, EvmAddress, Hex32, TokenAmount } from "../core/brand.js";
import type {
    AuxOutput,
    DepositRequest,
    Permit2Sig,
    PermitBatch,
    PermitSingle,
} from "../protocol/deposit-request.js";
import type {
    AssetEntry,
    CancelDepositInputs,
    EscrowedDepositView,
    Permit2SignArgs,
    TokenMeta,
} from "./types.js";

/**
 * Adapters MUST be deterministic w.r.t. constructor inputs (no hidden
 * global state).
 */
export interface ChainAdapter {
    chainId(): Promise<bigint>;
    /** Signer's eth address (== `pi.payer` for deposit). */
    payerAddress(): Promise<EvmAddress>;
    /** Used as the Permit2 `spender`. */
    maspAddress(): Promise<EvmAddress>;
    /**
     * `NativeAdapter` address, or `undefined` where none is deployed. It is
     * the `payer` a native deposit must name, so the deposit builder needs it
     * before it builds the request. Optional.
     */
    nativeAdapterAddress?(): EvmAddress | undefined;
    fetchAsset(id: AssetId): Promise<AssetEntry>;
    /** 0 disables fees. */
    fetchFeeBps(): Promise<bigint>;
    /**
     * Sign Permit2 `PermitWitnessTransferFrom` witness-bound to
     * `piHash = keccak256(abi.encode(DepositRequest, aux))`.
     */
    signPermit2(args: Permit2SignArgs): Promise<Permit2Sig>;
    /**
     * `MASP.deposit(d, sig, aux)`. Returns tx hash + deposit id from the
     * `DepositEscrowed` log. Optional: relayer-broadcast adapters omit.
     */
    submitDeposit?(args: {
        deposit: DepositRequest;
        permit2: Permit2Sig;
        aux: AuxOutput;
        /** The relayer fee note payload; a deposit mints two leaves. */
        feeAux: AuxOutput;
        /**
         * Fired after the wallet signs and the tx hash is known, before
         * receipt-wait.
         */
        onSent?: (txHash: Hex32) => void;
    }): Promise<{ txHash: Hex32; depositId: bigint }>;
    /**
     * `NativeAdapter.depositNative` with `msg.value = value`. The pool is
     * ERC-20 only, so the adapter wraps the coin, escrows it under its own
     * name and returns the excess — `deposit.payer` must therefore be the
     * adapter, not the sender. Asset id must be WETH-registered. Optional,
     * and unavailable on a chain with no adapter deployed.
     */
    submitDepositNative?(args: {
        deposit: DepositRequest;
        aux: AuxOutput;
        /** The relayer fee note payload; a deposit mints two leaves. */
        feeAux: AuxOutput;
        value: bigint;
        onSent?: (txHash: Hex32) => void;
    }): Promise<{ txHash: Hex32; depositId: bigint }>;
    /**
     * `MASP.depositAuthorized`. Pulls via Permit2 AllowanceTransfer against
     * a previously-signed window; no per-deposit sig. Optional.
     */
    submitDepositAuthorized?(args: {
        deposit: DepositRequest;
        aux: AuxOutput;
        /** The relayer fee note payload; a deposit mints two leaves. */
        feeAux: AuxOutput;
        onSent?: (txHash: Hex32) => void;
    }): Promise<{ txHash: Hex32; depositId: bigint }>;
    /** `IAllowanceTransfer.allowance` — cap, expiry, nonce. Optional. */
    permit2Allowance?(
        token: EvmAddress,
        owner: EvmAddress,
        spender: EvmAddress,
    ): Promise<{ amount: TokenAmount; expiration: number; nonce: number }>;
    /**
     * Submit pre-signed `PermitSingle` via `IAllowanceTransfer.permit`.
     * Anyone can submit; relayer-gasless variants may override. Optional.
     */
    permit2PermitAllowance?(
        args: {
            owner: EvmAddress;
            permit: PermitSingle;
            signature: string;
        },
        onTxHash?: (hash: Hex32) => void,
    ): Promise<{ txHash: Hex32 }>;
    /** Sign `PermitSingle` for AllowanceTransfer-mode deposits. Optional. */
    signPermit2Allowance?(permit: PermitSingle): Promise<{ signature: string }>;
    /**
     * Submit a pre-signed `PermitBatch` via the `permit` overload taking an
     * array — one tx establishes N token windows. Optional.
     */
    permit2PermitAllowanceBatch?(
        args: {
            owner: EvmAddress;
            permit: PermitBatch;
            signature: string;
        },
        onTxHash?: (hash: Hex32) => void,
    ): Promise<{ txHash: Hex32 }>;
    /** Sign one `PermitBatch` covering N tokens. Optional. */
    signPermit2AllowanceBatch?(permit: PermitBatch): Promise<{ signature: string }>;
    /**
     * `MASP.cancelDeposit`. On-chain digest check rejects tampered
     * preimages. Optional.
     */
    cancelDeposit?(id: bigint, inputs: CancelDepositInputs): Promise<{ txHash: Hex32 }>;
    /**
     * `NativeAdapter.cancelNative` — the only way to settle an adapter-owned
     * escrow by refund, since the pool would return the coin to the adapter.
     * No `payer`: the adapter supplies its own. Optional.
     */
    cancelDepositNative?(
        id: bigint,
        inputs: Omit<CancelDepositInputs, "payer">,
    ): Promise<{ txHash: Hex32 }>;
    /** `MASP.escrowed(id)` — null if flushed/cancelled. Optional. */
    getEscrowed?(id: bigint): Promise<EscrowedDepositView | null>;
    /** Blocks before `cancelDeposit` is allowed. Optional. */
    cancelDelay?(): Promise<number>;
    /**
     * Free slot in Permit2's unordered nonce bitmap. Optional; adapters
     * returning a deterministic nonce can omit.
     */
    permit2Nonce?(): Promise<bigint>;
    /** Optional. CLIs/UIs feature-check before calling. */
    tokenMeta?(tokenAddr: EvmAddress): Promise<TokenMeta>;
    tokenBalanceOf?(tokenAddr: EvmAddress, account: EvmAddress): Promise<TokenAmount>;
    /** Wei. Optional. */
    nativeBalance?(account: EvmAddress): Promise<bigint>;
    tokenAllowance?(
        tokenAddr: EvmAddress,
        owner: EvmAddress,
        spender: EvmAddress,
    ): Promise<TokenAmount>;
    tokenApprove?(
        tokenAddr: EvmAddress,
        spender: EvmAddress,
        amount: TokenAmount,
        onTxHash?: (hash: Hex32) => void,
    ): Promise<{ txHash: Hex32 }>;
    /** Optional; adapters that don't use Permit2 omit. */
    permit2Address?(): EvmAddress;
    /** `WETH9.deposit{value}`. Optional. */
    wrapNative?(wethAddr: EvmAddress, value: bigint): Promise<{ txHash: Hex32 }>;
    /**
     * Current chain tip. Feeds `SelectOpts.tipBlock`, without which the
     * selector's spend cooldown is inert. Names no address and no topic.
     * Optional.
     */
    blockNumber?(): Promise<number>;
    /** Returns block number + receipt status (1 = success, 0 = revert). */
    waitTxReceipt?(
        txHash: Hex32,
        confirmations?: number,
    ): Promise<{ blockNumber: number; status: number }>;
}

/**
 * Permit2 AllowanceTransfer deposit path (one signed window, N deposits).
 *
 * @internal
 */
export type AllowanceTransferChain = ChainAdapter &
    Required<
        Pick<
            ChainAdapter,
            | "submitDepositAuthorized"
            | "permit2Allowance"
            | "permit2PermitAllowance"
            | "signPermit2Allowance"
        >
    >;

/**
 * Native-ETH deposit path. The pool is ERC-20 only, so this runs through
 * `NativeAdapter`, which wraps `msg.value` and escrows the WETH as its own
 * payer — hence the address is part of the capability, not just the call.
 *
 * @internal
 */
export type NativeEthChain = ChainAdapter &
    Required<Pick<ChainAdapter, "submitDepositNative" | "nativeAdapterAddress">>;

/**
 * Batched AllowanceTransfer setup: one signature and one tx for N tokens.
 *
 * A strict narrowing of {@link AllowanceTransferChain} rather than a widening
 * of it — an adapter that can do single-token setup but not the batch stays
 * fully usable, it just does not get the multi-token flow.
 *
 * @internal
 */
export type AllowanceBatchChain = AllowanceTransferChain &
    Required<Pick<ChainAdapter, "signPermit2AllowanceBatch" | "permit2PermitAllowanceBatch">>;

export function supportsAllowanceBatch(c: ChainAdapter): c is AllowanceBatchChain {
    return (
        supportsAllowanceTransfer(c) &&
        !!c.signPermit2AllowanceBatch &&
        !!c.permit2PermitAllowanceBatch
    );
}

export function supportsAllowanceTransfer(c: ChainAdapter): c is AllowanceTransferChain {
    return (
        !!c.submitDepositAuthorized &&
        !!c.permit2Allowance &&
        !!c.permit2PermitAllowance &&
        !!c.signPermit2Allowance
    );
}

export function supportsNativeEth(c: ChainAdapter): c is NativeEthChain {
    // The address is what the deposit builder needs as `payer`, so an adapter
    // that can encode the call but cannot name the contract is not usable.
    return !!c.submitDepositNative && !!c.nativeAdapterAddress?.();
}
