// The `ChainAdapter` port and its capability subtypes.
//
// Most members are optional: an adapter implements the deposit paths its
// chain supports. The `supports*` guards below are how callers discover
// which path is available, since the interface alone cannot say.

import type { AssetId, EvmAddress, Hex32, TokenAmount } from "../core/brand.js";
import type {
    AuxOutput,
    DepositIntent,
    Permit2Sig,
    PermitSingle,
} from "../protocol/deposit-intent.js";
import type {
    AssetEntry,
    CancelIntentInputs,
    EscrowedIntentView,
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
    fetchAsset(id: AssetId): Promise<AssetEntry>;
    /** 0 disables fees. */
    fetchFeeBps(): Promise<bigint>;
    /**
     * Sign Permit2 `PermitWitnessTransferFrom` witness-bound to
     * `piHash = keccak256(abi.encode(DepositIntent, aux))`.
     */
    signPermit2(args: Permit2SignArgs): Promise<Permit2Sig>;
    /**
     * `MASP.submitIntent(d, sig, aux)`. Returns tx hash + intent id from
     * the `IntentEscrowed` log. Optional: relayer-broadcast adapters omit.
     */
    submitIntent?(args: {
        intent: DepositIntent;
        permit2: Permit2Sig;
        aux: [AuxOutput, AuxOutput];
        /**
         * Fired after the wallet signs and the tx hash is known, before
         * receipt-wait.
         */
        onSent?: (txHash: Hex32) => void;
    }): Promise<{ txHash: Hex32; intentId: bigint }>;
    /**
     * `MASP.submitIntentNative` with `msg.value = value`. Pool wraps
     * internally; no Permit2. Asset id must be WETH-registered. Optional.
     */
    submitIntentNative?(args: {
        intent: DepositIntent;
        aux: [AuxOutput, AuxOutput];
        value: bigint;
        onSent?: (txHash: Hex32) => void;
    }): Promise<{ txHash: Hex32; intentId: bigint }>;
    /**
     * `MASP.submitIntentAuthorized`. Pulls via Permit2 AllowanceTransfer
     * against a previously-signed window; no per-deposit sig. Optional.
     */
    submitIntentAuthorized?(args: {
        intent: DepositIntent;
        aux: [AuxOutput, AuxOutput];
        onSent?: (txHash: Hex32) => void;
    }): Promise<{ txHash: Hex32; intentId: bigint }>;
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
     * `MASP.cancelIntent`. On-chain digest check rejects tampered
     * preimages. Optional.
     */
    cancelIntent?(id: bigint, inputs: CancelIntentInputs): Promise<{ txHash: Hex32 }>;
    /** `MASP.escrowed(id)` — null if flushed/cancelled. Optional. */
    getEscrowed?(id: bigint): Promise<EscrowedIntentView | null>;
    /** Blocks before `cancelIntent` is allowed. Optional. */
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
            | "submitIntentAuthorized"
            | "permit2Allowance"
            | "permit2PermitAllowance"
            | "signPermit2Allowance"
        >
    >;

/**
 * Native-ETH deposit path; pool wraps msg.value internally.
 *
 * @internal
 */
export type NativeEthChain = ChainAdapter & Required<Pick<ChainAdapter, "submitIntentNative">>;

export function supportsAllowanceTransfer(c: ChainAdapter): c is AllowanceTransferChain {
    return (
        !!c.submitIntentAuthorized &&
        !!c.permit2Allowance &&
        !!c.permit2PermitAllowance &&
        !!c.signPermit2Allowance
    );
}

export function supportsNativeEth(c: ChainAdapter): c is NativeEthChain {
    return !!c.submitIntentNative;
}
