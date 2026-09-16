// The `ChainAdapter` port, its read-only half, and their capability subtypes.
//
// The port is split in two. `ChainReader` is everything a chain can answer
// without a signing key; `ChainAdapter` adds the members that put a
// transaction on chain from the user's own EOA. A spend proves in the circuit
// and is broadcast by the relayer, so the spend path never leaves
// `ChainReader`, while a deposit requires `ChainAdapter`. A wallet backed by a
// passkey has the former and not the latter.
//
// Most members are optional: an adapter implements the deposit paths its
// chain supports. Callers discover which path is available through the
// `supports*` guards below, since the interface alone cannot say.
//
// Each half is assembled from narrower interfaces grouped by what they touch
// (registry, tree, tokens, receipts; deposits, Permit2 windows, the native
// coin), so a component can depend on only the slice it reads.

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
    CancelDepositReceipt,
    DepositEscrowedRecord,
    DepositSubmitted,
    EscrowedDepositView,
    Permit2SignArgs,
    TokenMeta,
    TxLog,
} from "./types.js";

/** The pool's registry and deposit bookkeeping. */
export interface RegistryReads {
    chainId(): Promise<bigint>;
    /** Used as the Permit2 `spender`. */
    maspAddress(): Promise<EvmAddress>;
    /**
     * `NativeAdapter` address, or `undefined` where none is deployed. It is
     * the `payer` a native deposit must name, so the deposit builder needs it
     * before it builds the request. Also read by `withdraw({ native })`, a relayed
     * spend, hence a read rather than part of the signing half. Optional.
     */
    nativeAdapterAddress?(): EvmAddress | undefined;
    /**
     * The registry entry, including the asset's two protocol fee rates. There
     * is no pool-wide rate: fees are per-asset and per-leg, so they are read
     * with the entry that defines them. 0 bps disables a leg's fee.
     */
    fetchAsset(id: AssetId): Promise<AssetEntry>;
    /** `MASP.escrowed(id)` — null if flushed/cancelled. Optional. */
    getEscrowed?(id: bigint): Promise<EscrowedDepositView | null>;
    /**
     * The `DepositEscrowed` log for escrow `id`, decoded, or `null` when none is found from
     * `fromBlock` (default: an adapter-chosen recent window) to the tip. `cancelDeposit({ depositId })`
     * rebuilds its cancel inputs from it. Optional.
     */
    fetchDepositEscrowed?(id: bigint, fromBlock?: bigint): Promise<DepositEscrowedRecord | null>;
    /**
     * Blocks, in the EVM's `block.number`, after `submittedAt` before `cancelDeposit` is
     * allowed. Optional.
     */
    cancelDelay?(): Promise<number>;
    /** Optional; adapters that don't use Permit2 omit. */
    permit2Address?(): EvmAddress;
}

/** What a spend needs to witness against the pool's tree and the selector's cooldown. */
export interface TreeReads {
    /**
     * Whether the pool would accept a proof against `root`, from the 64-root
     * ring it keeps. This is authoritative; the commitment mirror approximates it.
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
}

/** ERC-20, native-coin and Permit2 state of an account. */
export interface TokenReads {
    /** `IAllowanceTransfer.allowance` — cap, expiry, nonce. Optional. */
    permit2Allowance?(
        token: EvmAddress,
        owner: EvmAddress,
        spender: EvmAddress,
    ): Promise<{ amount: TokenAmount; expiration: number; nonce: number }>;
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
}

/** Receipts of mined transactions. */
export interface ReceiptReads {
    /** Returns block number + receipt status (1 = success, 0 = revert). */
    waitTxReceipt?(
        txHash: Hex32,
        confirmations?: number,
    ): Promise<{ blockNumber: number; status: number }>;
    /**
     * Every log of a mined transaction's receipt, in receipt order.
     *
     * Read after a relayed spend to find the wallet's own operation in a
     * transaction the relayer may have bundled with others'. Only the hash is
     * sent; the matching against the wallet's commitments happens locally.
     * Optional: without it a spend result carries no `operation`.
     */
    txReceiptLogs?(txHash: Hex32): Promise<readonly TxLog[]>;
}

/**
 * Everything a chain can answer without a signing key.
 *
 * This is the whole surface the spend path uses: `executeTransfer` touches
 * none of it, `executeWithdraw` reads `nativeAdapterAddress`, and the selector
 * and tree sync read `blockNumber` and `isKnownRoot`. `fetchAsset` is required
 * because every amount the wallet formats, every fee it quotes and every asset
 * it names resolves through the registry.
 *
 * Implementations MUST be deterministic w.r.t. constructor inputs (no hidden
 * global state).
 */
export interface ChainReader extends RegistryReads, TreeReads, TokenReads, ReceiptReads {}

/** Signing as the user's EOA, and the deposit and cancel calls that spend its gas. */
export interface DepositWrites {
    /** Signer's eth address (== `pi.payer` for deposit). */
    payerAddress(): Promise<EvmAddress>;
    /**
     * Sign a Permit2 witness transfer bound to
     * `piHash = keccak256(abi.encode(DepositRequest, aux, feeAux))`.
     *
     * `PermitWitnessTransferFrom` over `token` alone, or, when `args.feeToken`
     * is set, `PermitBatchWitnessTransferFrom` over `[token, feeToken]`. The
     * returned `maxFee` is `0n` for the former.
     */
    signPermit2(args: Permit2SignArgs): Promise<Permit2Sig>;
    /**
     * `MASP.deposit(d, sig, aux)`. Resolves once mined with the hash, block and the
     * `DepositEscrowed` payload from the receipt. Optional: relayer-broadcast adapters omit.
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
    }): Promise<DepositSubmitted>;
    /**
     * `MASP.depositAuthorized`. Pulls via Permit2 AllowanceTransfer against
     * an already-signed window; no per-deposit sig. Optional.
     */
    submitDepositAuthorized?(args: {
        deposit: DepositRequest;
        aux: AuxOutput;
        /** The relayer fee note payload; a deposit mints two leaves. */
        feeAux: AuxOutput;
        onSent?: (txHash: Hex32) => void;
    }): Promise<DepositSubmitted>;
    /**
     * `MASP.cancelDeposit`. On-chain digest check rejects tampered
     * preimages. Resolves once mined, with the refund split read off
     * `DepositCanceled`. Optional.
     */
    cancelDeposit?(id: bigint, inputs: CancelDepositInputs): Promise<CancelDepositReceipt>;
}

/** Permit2 AllowanceTransfer windows, and the ERC-20 approval that funds them. */
export interface Permit2Writes {
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
     * array; one tx establishes N token windows. Optional.
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
    tokenApprove?(
        tokenAddr: EvmAddress,
        spender: EvmAddress,
        amount: TokenAmount,
        onTxHash?: (hash: Hex32) => void,
    ): Promise<{ txHash: Hex32 }>;
}

/** The native coin, which the pool reaches only through `NativeAdapter` and WETH. */
export interface NativeWrites {
    /**
     * `NativeAdapter.depositNative` with `msg.value = value`. The pool is
     * ERC-20 only, so the adapter wraps the coin, escrows it under its own
     * name and returns the excess; `deposit.payer` must therefore be the
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
    }): Promise<DepositSubmitted>;
    /**
     * `NativeAdapter.cancelNative`: the only way to settle an adapter-owned
     * escrow by refund, since the pool would return the coin to the adapter.
     * No `payer`: the adapter supplies its own. Optional.
     */
    cancelDepositNative?(
        id: bigint,
        inputs: Omit<CancelDepositInputs, "payer">,
    ): Promise<CancelDepositReceipt>;
    /** `WETH9.deposit{value}`. Optional. */
    wrapNative?(wethAddr: EvmAddress, value: bigint): Promise<{ txHash: Hex32 }>;
}

/**
 * A reader that also holds a signing key.
 *
 * Every member here either signs as the user's EOA or spends its gas, making
 * this the deposit half: shielding moves public tokens out of an address that
 * must both custody them and pay for the transaction. Narrow with
 * {@link supportsSigning} before using any of these.
 *
 * Adapters MUST be deterministic w.r.t. constructor inputs (no hidden
 * global state).
 */
export interface ChainAdapter extends ChainReader, DepositWrites, Permit2Writes, NativeWrites {}

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
 * payer; the address is therefore part of the capability, not only the call.
 *
 * @internal
 */
export type NativeEthChain = ChainAdapter &
    Required<Pick<ChainAdapter, "submitDepositNative" | "nativeAdapterAddress">>;

/**
 * Batched AllowanceTransfer setup: one signature and one tx for N tokens.
 *
 * A strict narrowing of {@link AllowanceTransferChain}: an adapter that supports
 * single-token setup but not the batch stays usable, without the multi-token
 * flow.
 *
 * @internal
 */
export type AllowanceBatchChain = AllowanceTransferChain &
    Required<Pick<ChainAdapter, "signPermit2AllowanceBatch" | "permit2PermitAllowanceBatch">>;

/**
 * Whether this reader also signs; the gate in front of every deposit path.
 *
 * Both members are required on {@link ChainAdapter}, so their presence
 * separates the two halves of the port.
 *
 * This is the primitive for code holding a bare chain layer. Code holding a
 * wallet should use `supportsDeposit(wallet)` from `@lelantos-org/sdk/advanced`,
 * which answers the same question and narrows the wallet rather than the layer
 * inside it.
 */
export function supportsSigning(c: ChainReader): c is ChainAdapter {
    // `Partial`, not `ChainAdapter`: this probes for absence, so the cast must
    // not assert the members it tests for.
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
    // The deposit builder needs the address as `payer`, so an adapter that can
    // encode the call but cannot name the contract is unusable.
    return supportsSigning(c) && !!c.submitDepositNative && !!c.nativeAdapterAddress?.();
}
