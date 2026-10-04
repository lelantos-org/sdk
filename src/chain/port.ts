// The `ChainAdapter` port, its read-only half, and their capability subtypes.
//
// `ChainReader` is everything a chain can answer without a signing key;
// `ChainAdapter` adds the members that put a transaction on chain from the
// user's own EOA. A spend is broadcast by the relayer, so it needs only
// `ChainReader`; a deposit requires `ChainAdapter`.
//
// Most members are optional: an adapter implements the deposit paths its
// chain supports, and callers discover them through the `supports*` guards.

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
    PublishedNote,
    TokenMeta,
    TxLog,
} from "./types.js";

/** The pool's registry and deposit bookkeeping. */
export interface RegistryReads {
    chainId(): Promise<bigint>;
    /** Used as the Permit2 `spender`. */
    maspAddress(): Promise<EvmAddress>;
    /**
     * `NativeAdapter` address, or `undefined` where none is deployed: the
     * `payer` a native deposit names. Also read by `withdraw({ native })`.
     * Optional.
     */
    nativeAdapterAddress?(): EvmAddress | undefined;
    /**
     * The registry entry, including the asset's protocol fee rates, which are
     * per-asset and per-leg. 0 bps disables a leg's fee.
     */
    fetchAsset(id: AssetId): Promise<AssetEntry>;
    /** `MASP.escrowed(id)`; `null` if flushed or cancelled. Optional. */
    getEscrowed?(id: bigint): Promise<EscrowedDepositView | null>;
    /**
     * The decoded `DepositEscrowed` log for escrow `id`, or `null` when none is
     * found from `fromBlock` (default: an adapter-chosen recent window) to the
     * tip. `cancelDeposit({ depositId })` rebuilds its cancel inputs from it.
     * Optional.
     */
    fetchDepositEscrowed?(id: bigint, fromBlock?: bigint): Promise<DepositEscrowedRecord | null>;
    /**
     * Blocks, in the EVM's `block.number`, after `submittedAt` before
     * `cancelDeposit` is allowed. Optional.
     */
    cancelDelay?(): Promise<number>;
    /** Optional: omitted by adapters that do not use Permit2. */
    permit2Address?(): EvmAddress;
}

/** What a spend needs to witness against the pool's tree and the selector's cooldown. */
export interface TreeReads {
    /**
     * Whether the pool would accept a proof against `root`, from the ring of
     * recent roots it keeps. Authoritative; the commitment mirror approximates
     * it. Optional: without it the mirror decides.
     */
    isKnownRoot?: IsKnownRoot;
    /**
     * Current chain tip. Feeds `SelectOpts.tipBlock`, without which the
     * selector's spend cooldown is inert. The request names no address and no
     * topic. Optional.
     */
    blockNumber?(): Promise<number>;
}

/** ERC-20, native-coin and Permit2 state of an account. */
export interface TokenReads {
    /** `IAllowanceTransfer.allowance`: cap, expiry, nonce. Optional. */
    permit2Allowance?(
        token: EvmAddress,
        owner: EvmAddress,
        spender: EvmAddress,
    ): Promise<{ amount: TokenAmount; expiration: number; nonce: number }>;
    /**
     * Free slot in Permit2's unordered nonce bitmap. Optional: omitted by
     * adapters returning a deterministic nonce.
     */
    permit2Nonce?(): Promise<bigint>;
    /** Optional; callers feature-check before calling. */
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
    /** Block number and receipt status (1 = success, 0 = revert). */
    waitTxReceipt?(
        txHash: Hex32,
        confirmations?: number,
    ): Promise<{ blockNumber: number; status: number }>;
    /**
     * Every log of a mined transaction's receipt, in receipt order.
     *
     * Read after a relayed spend to find the wallet's own operation in a
     * transaction the relayer may have bundled with others'. Only the hash is
     * sent; matching against the wallet's commitments happens locally.
     * Optional: without it a spend result carries no `operation`.
     */
    txReceiptLogs?(txHash: Hex32): Promise<readonly TxLog[]>;
    /**
     * The decoded `NotePayload` the pool emitted for commitment `cm` in mined
     * transaction `txHash`, or `null` when that transaction carries none from
     * the pool. A payment proof needs the output's published `ephPub` and
     * ciphertext. Optional.
     */
    fetchNotePayload?(txHash: Hex32, cm: Hex32): Promise<PublishedNote | null>;
}

/**
 * Everything a chain can answer without a signing key, which is all the spend
 * path uses.
 *
 * `fetchAsset` is required because every amount the wallet formats, every fee
 * it quotes and every asset it names resolves through the registry.
 *
 * Implementations must be deterministic w.r.t. constructor inputs (no hidden
 * global state).
 */
export interface ChainReader extends RegistryReads, TreeReads, TokenReads, ReceiptReads {}

/** Signing as the user's EOA, and the deposit and cancel calls that spend its gas. */
export interface DepositWrites {
    /** The signer's address; `pi.payer` for a deposit. */
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
     * `MASP.deposit(d, sig, aux, feeAux)`. Resolves once mined, with the hash,
     * block and `DepositEscrowed` payload from the receipt. Optional: omitted
     * by relayer-broadcast adapters.
     */
    submitDeposit?(args: {
        deposit: DepositRequest;
        permit2: Permit2Sig;
        aux: AuxOutput;
        /** The relayer fee note payload; a deposit mints two leaves. */
        feeAux: AuxOutput;
        /** Fired once the wallet has signed and the tx hash is known, before the receipt wait. */
        onSent?: (txHash: Hex32) => void;
    }): Promise<DepositSubmitted>;
    /**
     * `MASP.depositAuthorized`. Pulls via Permit2 AllowanceTransfer against
     * an already-signed window; no per-deposit sig. Optional.
     */
    submitDepositAuthorized?(args: {
        deposit: DepositRequest;
        aux: AuxOutput;
        /** The relayer fee note payload. */
        feeAux: AuxOutput;
        onSent?: (txHash: Hex32) => void;
    }): Promise<DepositSubmitted>;
    /**
     * `MASP.cancelDeposit`. The on-chain digest check rejects tampered
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
        /** The relayer fee note payload. */
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
 * Every member added here either signs as the user's EOA or spends its gas:
 * shielding moves public tokens out of an address that must both custody them
 * and pay for the transaction. Narrow with {@link supportsSigning} before
 * using any of them.
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
 * Native-ETH deposit path through `NativeAdapter`. The adapter is the
 * deposit's payer, so its address is part of the capability, not only the call.
 *
 * @internal
 */
export type NativeEthChain = ChainAdapter &
    Required<Pick<ChainAdapter, "submitDepositNative" | "nativeAdapterAddress">>;

/**
 * Batched AllowanceTransfer setup: one signature and one tx for N tokens.
 *
 * A strict narrowing of {@link AllowanceTransferChain}: an adapter with
 * single-token setup only stays usable, without the multi-token flow.
 *
 * @internal
 */
export type AllowanceBatchChain = AllowanceTransferChain &
    Required<Pick<ChainAdapter, "signPermit2AllowanceBatch" | "permit2PermitAllowanceBatch">>;

/**
 * Whether this reader also signs; the gate in front of every deposit path.
 *
 * Both members tested are required on {@link ChainAdapter}, so their presence
 * separates the two halves of the port.
 *
 * Code holding a wallet rather than a bare chain layer should use
 * `supportsDeposit(wallet)` from `@lelantos-org/sdk/advanced`, which narrows
 * the wallet instead.
 */
export function supportsSigning(c: ChainReader): c is ChainAdapter {
    // `Partial`, not `ChainAdapter`: this probes for absence, so the cast must
    // not assert the members it tests for.
    const a = c as Partial<ChainAdapter>;
    return typeof a.payerAddress === "function" && typeof a.signPermit2 === "function";
}

// The three guards below need no cast: the predicate left of `&&` narrows `c`
// to `ChainAdapter`, where every member they test is optional.
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
