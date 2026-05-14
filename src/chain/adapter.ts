// Pluggable chain layer. Bridges a transport (ethers/viem/web3.js) to:
// asset/fee lookup, Permit2 witness signing, `cancelIntent` broadcast,
// `escrowed(id)` reads.

import type { AuxOutput, DepositIntent, Permit2Sig, PermitSingle } from "../bundle/permit2.js";

/** @internal */
export interface AssetEntry {
    token: string;
    /// circuit-units → ERC20-base-units multiplier.
    scale: bigint;
}

/** @internal */
export interface Permit2SignArgs {
    /// ERC-20 being pulled into escrow.
    token: string;
    /// Ceiling on `inAmt + fee` in token base units. Bound into the sig
    /// as `permitted.amount`.
    maxTotal: bigint;
    /// Unix-seconds expiry.
    deadline: bigint;
    /// `keccak256(abi.encode(DepositIntent, aux))`. Binds the sig to a
    /// specific deposit.
    piHash: string;
    /// Fresh value; Permit2 uses an unordered bitmap.
    nonce: bigint;
}

/** @internal */
/// `MASP.escrowed(id)` view. `cm0/cm1/publicIn/feeBpsAtSubmit` are
/// folded into `digest`; reconstruct via the `IntentEscrowed` log.
export interface EscrowedIntentView {
    digest: string;
    payer: string;
    /// block number of submitIntent.
    submittedAt: number;
    publicAssetId: bigint;
}

/** @internal */
/// Preimage fields for `cancelIntent`. On-chain digest check binds these
/// to what was escrowed at submit. Sourced from `IntentEscrowedRecord`.
export interface CancelIntentInputs {
    publicIn: bigint;
    feeBpsAtSubmit: number;
    cm0: string;
    cm1: string;
    cvDep0: [bigint, bigint];
    cvDep1: [bigint, bigint];
}

/** @internal */
/// Decoded `IntentEscrowed` event. Cache to feed `cancelIntent` and
/// reconstruct removed `escrowed()` storage fields.
export interface IntentEscrowedRecord {
    id: bigint;
    payer: string;
    recipient: string;
    publicAssetId: bigint;
    publicIn: bigint;
    feeBpsAtSubmit: number;
    cm0: string;
    cm1: string;
    cvDep0: [bigint, bigint];
    cvDep1: [bigint, bigint];
    rcvTotal: bigint;
}

/** @internal */
/// ERC20 display metadata.
export interface TokenMeta {
    symbol: string;
    decimals: number;
}

/// Adapters MUST be deterministic w.r.t. constructor inputs (no hidden
/// global state).
export interface ChainAdapter {
    chainId(): Promise<bigint>;
    /// Signer's eth address (== `pi.payer` for deposit).
    payerAddress(): Promise<string>;
    /// Used as the Permit2 `spender`.
    maspAddress(): Promise<string>;
    fetchAsset(id: bigint): Promise<AssetEntry>;
    /// 0 disables fees.
    fetchFeeBps(): Promise<bigint>;
    /// Sign Permit2 `PermitWitnessTransferFrom` witness-bound to
    /// `piHash = keccak256(abi.encode(DepositIntent, aux))`.
    signPermit2(args: Permit2SignArgs): Promise<Permit2Sig>;
    /// `MASP.submitIntent(d, sig, aux)`. Returns tx hash + intent id from
    /// the `IntentEscrowed` log. Optional: relayer-broadcast adapters omit.
    submitIntent?(args: {
        intent: DepositIntent;
        permit2: Permit2Sig;
        aux: [AuxOutput, AuxOutput];
        /// Fired after the wallet signs and the tx hash is known, before
        /// receipt-wait. Used by callers to separate "sign" from "mined"
        /// in user-facing progress UI.
        onSent?: (txHash: string) => void;
    }): Promise<{ txHash: string; intentId: bigint }>;
    /// `MASP.submitIntentNative` with `msg.value = value`. Pool wraps
    /// internally; no Permit2. Asset id must be WETH-registered. Optional.
    submitIntentNative?(args: {
        intent: DepositIntent;
        aux: [AuxOutput, AuxOutput];
        value: bigint;
        onSent?: (txHash: string) => void;
    }): Promise<{ txHash: string; intentId: bigint }>;
    /// `MASP.submitIntentAuthorized`. Pulls via Permit2 AllowanceTransfer
    /// against a previously-signed window; no per-deposit sig. Optional.
    submitIntentAuthorized?(args: {
        intent: DepositIntent;
        aux: [AuxOutput, AuxOutput];
        onSent?: (txHash: string) => void;
    }): Promise<{ txHash: string; intentId: bigint }>;
    /// `IAllowanceTransfer.allowance` — cap, expiry, nonce. Optional.
    permit2Allowance?(
        token: string,
        owner: string,
        spender: string,
    ): Promise<{ amount: bigint; expiration: number; nonce: number }>;
    /// Submit pre-signed `PermitSingle` via `IAllowanceTransfer.permit`.
    /// Anyone can submit; relayer-gasless variants may override. Optional.
    permit2PermitAllowance?(
        args: {
            owner: string;
            permit: PermitSingle;
            signature: string;
        },
        onTxHash?: (hash: string) => void,
    ): Promise<{ txHash: string }>;
    /// Sign `PermitSingle` for AllowanceTransfer-mode deposits. Optional.
    signPermit2Allowance?(permit: PermitSingle): Promise<{ signature: string }>;
    /// `MASP.cancelIntent`. On-chain digest check rejects tampered
    /// preimages. Optional.
    cancelIntent?(id: bigint, inputs: CancelIntentInputs): Promise<{ txHash: string }>;
    /// `MASP.escrowed(id)` — null if flushed/cancelled. Optional.
    getEscrowed?(id: bigint): Promise<EscrowedIntentView | null>;
    /// Blocks before `cancelIntent` is allowed. Optional.
    cancelDelay?(): Promise<number>;
    /// Free slot in Permit2's unordered nonce bitmap. Optional; adapters
    /// returning a deterministic nonce can omit.
    permit2Nonce?(): Promise<bigint>;
    /// Optional. CLIs/UIs feature-check before calling.
    tokenMeta?(tokenAddr: string): Promise<TokenMeta>;
    tokenBalanceOf?(tokenAddr: string, account: string): Promise<bigint>;
    /// Wei. Optional.
    nativeBalance?(account: string): Promise<bigint>;
    tokenAllowance?(tokenAddr: string, owner: string, spender: string): Promise<bigint>;
    tokenApprove?(
        tokenAddr: string,
        spender: string,
        amount: bigint,
        onTxHash?: (hash: string) => void,
    ): Promise<{ txHash: string }>;
    /// Optional; adapters that don't use Permit2 omit.
    permit2Address?(): string;
    /// `WETH9.deposit{value}`. Optional.
    wrapNative?(wethAddr: string, value: bigint): Promise<{ txHash: string }>;
    /// Returns block number + receipt status (1 = success, 0 = revert).
    waitTxReceipt?(
        txHash: string,
        confirmations?: number,
    ): Promise<{ blockNumber: number; status: number }>;
}

/** @internal */
/// Required-method core; every adapter provides these.
export type CoreChain = Pick<
    ChainAdapter,
    "chainId" | "payerAddress" | "maspAddress" | "fetchAsset" | "fetchFeeBps" | "signPermit2"
>;

/** @internal */
/// Permit2 SignatureTransfer (witness) deposit path.
export type Permit2WitnessChain = ChainAdapter &
    Required<Pick<ChainAdapter, "submitIntent" | "signPermit2">>;

/** @internal */
/// Permit2 AllowanceTransfer deposit path (one signed window, N deposits).
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

/** @internal */
/// Native-ETH deposit path; pool wraps msg.value internally.
export type NativeEthChain = ChainAdapter & Required<Pick<ChainAdapter, "submitIntentNative">>;

export function supportsAllowanceTransfer(c: ChainAdapter): c is AllowanceTransferChain {
    return (
        !!c.submitIntentAuthorized &&
        !!c.permit2Allowance &&
        !!c.permit2PermitAllowance &&
        !!c.signPermit2Allowance
    );
}

/** @internal */
export function supportsNativeEth(c: ChainAdapter): c is NativeEthChain {
    return !!c.submitIntentNative;
}

/** @internal */
export function supportsPermit2Witness(c: ChainAdapter): c is Permit2WitnessChain {
    return !!c.submitIntent && !!c.signPermit2;
}
