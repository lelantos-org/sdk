// The `ChainAdapter` port and its capability subtypes.
//
// Most members are optional: an adapter implements the deposit paths its
// chain supports. The `supports*` guards below are how callers discover
// which path is available, since the interface alone cannot say.

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
    payerAddress(): Promise<string>;
    /** Used as the Permit2 `spender`. */
    maspAddress(): Promise<string>;
    fetchAsset(id: bigint): Promise<AssetEntry>;
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
        onSent?: (txHash: string) => void;
    }): Promise<{ txHash: string; intentId: bigint }>;
    /**
     * `MASP.submitIntentNative` with `msg.value = value`. Pool wraps
     * internally; no Permit2. Asset id must be WETH-registered. Optional.
     */
    submitIntentNative?(args: {
        intent: DepositIntent;
        aux: [AuxOutput, AuxOutput];
        value: bigint;
        onSent?: (txHash: string) => void;
    }): Promise<{ txHash: string; intentId: bigint }>;
    /**
     * `MASP.submitIntentAuthorized`. Pulls via Permit2 AllowanceTransfer
     * against a previously-signed window; no per-deposit sig. Optional.
     */
    submitIntentAuthorized?(args: {
        intent: DepositIntent;
        aux: [AuxOutput, AuxOutput];
        onSent?: (txHash: string) => void;
    }): Promise<{ txHash: string; intentId: bigint }>;
    /** `IAllowanceTransfer.allowance` — cap, expiry, nonce. Optional. */
    permit2Allowance?(
        token: string,
        owner: string,
        spender: string,
    ): Promise<{ amount: bigint; expiration: number; nonce: number }>;
    /**
     * Submit pre-signed `PermitSingle` via `IAllowanceTransfer.permit`.
     * Anyone can submit; relayer-gasless variants may override. Optional.
     */
    permit2PermitAllowance?(
        args: {
            owner: string;
            permit: PermitSingle;
            signature: string;
        },
        onTxHash?: (hash: string) => void,
    ): Promise<{ txHash: string }>;
    /** Sign `PermitSingle` for AllowanceTransfer-mode deposits. Optional. */
    signPermit2Allowance?(permit: PermitSingle): Promise<{ signature: string }>;
    /**
     * `MASP.cancelIntent`. On-chain digest check rejects tampered
     * preimages. Optional.
     */
    cancelIntent?(id: bigint, inputs: CancelIntentInputs): Promise<{ txHash: string }>;
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
    tokenMeta?(tokenAddr: string): Promise<TokenMeta>;
    tokenBalanceOf?(tokenAddr: string, account: string): Promise<bigint>;
    /** Wei. Optional. */
    nativeBalance?(account: string): Promise<bigint>;
    tokenAllowance?(tokenAddr: string, owner: string, spender: string): Promise<bigint>;
    tokenApprove?(
        tokenAddr: string,
        spender: string,
        amount: bigint,
        onTxHash?: (hash: string) => void,
    ): Promise<{ txHash: string }>;
    /** Optional; adapters that don't use Permit2 omit. */
    permit2Address?(): string;
    /** `WETH9.deposit{value}`. Optional. */
    wrapNative?(wethAddr: string, value: bigint): Promise<{ txHash: string }>;
    /** Returns block number + receipt status (1 = success, 0 = revert). */
    waitTxReceipt?(
        txHash: string,
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
