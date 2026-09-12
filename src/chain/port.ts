// The `ChainAdapter` port, its read-only half, and their capability subtypes.
//
// The port is split in two. `ChainReader` is everything a chain can answer
// without a signing key; `ChainAdapter` adds the members that put a
// transaction on chain from the user's own EOA. The split is not cosmetic: a
// spend proves in the circuit and is broadcast by the relayer, so the spend
// path never leaves `ChainReader`, while a deposit cannot be expressed without
// `ChainAdapter`. A wallet backed by a passkey has the former and not the
// latter.
//
// Most members are optional: an adapter implements the deposit paths its
// chain supports. The `supports*` guards below are how callers discover
// which path is available, since the interface alone cannot say.

import type { AssetId, EvmAddress, Hex32, TokenAmount } from "../core/brand.js";
import type { IsKnownRoot } from "../crypto/path.js";
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
 * Everything a chain can answer without a signing key.
 *
 * This is the whole surface the spend path uses: `executeTransfer` touches
 * none of it, `executeWithdraw` reads `nativeAdapterAddress`, and the selector
 * and tree sync read `blockNumber` and `isKnownRoot`. `fetchAsset` is required
 * rather than optional because every amount the wallet formats, every fee it
 * quotes and every asset it names resolves through the registry — a wallet
 * that cannot read it has no UI, only a spend it cannot describe.
 *
 * Implementations MUST be deterministic w.r.t. constructor inputs (no hidden
 * global state).
 */
export interface ChainReader {
    chainId(): Promise<bigint>;
    /** Used as the Permit2 `spender`. */
    maspAddress(): Promise<EvmAddress>;
    /**
     * `NativeAdapter` address, or `undefined` where none is deployed. It is
     * the `payer` a native deposit must name, so the deposit builder needs it
     * before it builds the request. Also read by `withdrawEth`, which is a
     * relayed spend — hence a read, not part of the signing half. Optional.
     */
    nativeAdapterAddress?(): EvmAddress | undefined;
    /**
     * The registry entry, including the asset's two protocol fee rates. There
     * is no pool-wide rate: fees are per-asset and per-leg, so they are read
     * with the entry that defines them. 0 bps disables a leg's fee.
     */
    fetchAsset(id: AssetId): Promise<AssetEntry>;
    /** `IAllowanceTransfer.allowance` — cap, expiry, nonce. Optional. */
    permit2Allowance?(
        token: EvmAddress,
        owner: EvmAddress,
        spender: EvmAddress,
    ): Promise<{ amount: TokenAmount; expiration: number; nonce: number }>;
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
    /** Optional; adapters that don't use Permit2 omit. */
    permit2Address?(): EvmAddress;
    /**
     * Whether the pool would accept a proof against `root`, from the 64-root
     * ring it keeps. The authority the commitment mirror only approximates.
     *
     * Optional, like the reads around it: an adapter that cannot reach the pool
     * leaves the mirror as the last word.
     */
    isKnownRoot?: IsKnownRoot;
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
 * A reader that also holds a signing key.
 *
 * Everything here either signs as the user's EOA or spends its gas, which is
 * why it is the deposit half: shielding value moves public tokens out of an
 * address that must both custody them and pay for the transaction. Narrow to
 * it with {@link supportsSigning} before reaching for any of these.
 *
 * Adapters MUST be deterministic w.r.t. constructor inputs (no hidden
 * global state).
 */
export interface ChainAdapter extends ChainReader {
    /** Signer's eth address (== `pi.payer` for deposit). */
    payerAddress(): Promise<EvmAddress>;
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
    tokenApprove?(
        tokenAddr: EvmAddress,
        spender: EvmAddress,
        amount: TokenAmount,
        onTxHash?: (hash: Hex32) => void,
    ): Promise<{ txHash: Hex32 }>;
    /** `WETH9.deposit{value}`. Optional. */
    wrapNative?(wethAddr: EvmAddress, value: bigint): Promise<{ txHash: Hex32 }>;
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

/**
 * Whether this reader also signs — the gate in front of every deposit path.
 *
 * Both members are required on {@link ChainAdapter}, so their presence is what
 * separates the two halves of the port.
 *
 * This is the primitive, for code holding a bare chain layer. If you hold a
 * wallet, ask `supportsDeposit(wallet)` from `@lelantos-org/sdk/wallet`
 * instead — same question, one fewer hop, and it narrows the wallet rather
 * than the layer inside it.
 */
export function supportsSigning(c: ChainReader): c is ChainAdapter {
    // `Partial`, not `ChainAdapter`: this probes for absence, so the cast must
    // not assert the very members it is about to test for.
    const a = c as Partial<ChainAdapter>;
    return typeof a.payerAddress === "function" && typeof a.signPermit2 === "function";
}

// The three guards below need no cast: the predicate on the left of `&&`
// narrows `c` to `ChainAdapter` for the rest of the expression, and every
// member they test is optional there.
export function supportsAllowanceBatch(c: ChainReader): c is AllowanceBatchChain {
    return (
        supportsAllowanceTransfer(c) &&
        !!c.signPermit2AllowanceBatch &&
        !!c.permit2PermitAllowanceBatch
    );
}

export function supportsAllowanceTransfer(c: ChainReader): c is AllowanceTransferChain {
    return (
        supportsSigning(c) &&
        !!c.submitDepositAuthorized &&
        !!c.permit2Allowance &&
        !!c.permit2PermitAllowance &&
        !!c.signPermit2Allowance
    );
}

export function supportsNativeEth(c: ChainReader): c is NativeEthChain {
    // The address is what the deposit builder needs as `payer`, so an adapter
    // that can encode the call but cannot name the contract is not usable.
    return supportsSigning(c) && !!c.submitDepositNative && !!c.nativeAdapterAddress?.();
}
