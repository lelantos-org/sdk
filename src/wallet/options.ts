// Wallet operation options. Re-exported from `./api.ts` and the public barrel.

import type {
    AssetIdLike,
    EvmAddressLike,
    ShieldedAddress,
    ShieldedAddressLike,
} from "../core/brand.js";
import type { SwapQuote } from "../services/quoter/client.js";
import type { AmountLike } from "./amount.js";
import type { AssetRef } from "./asset-ref.js";
import type { SelectOpts } from "./selection.js";

export type DepositPhase = "signing" | "submitting" | "broadcast" | "mined";
export type SpendPhase = "preparing" | "proving" | "submitting";

/** Phase callback shape used by every spend-side operation. */
export type OnPhase<P extends string> = (phase: P) => void;

/** Shield ERC-20 into the MASP. For native ETH, set `asEth: true`. */
export interface DepositOptions {
    /**
     * `bigint` is exact circuit units; a string is a human amount of the
     * token, e.g. `"0.25"`. See {@link AmountLike}.
     */
    amount: AmountLike;
    /** Id, token address or symbol. Default asset 1. */
    asset?: AssetRef | undefined;
    /** Shielded recipient. Defaults to own address. */
    to?: ShieldedAddressLike | undefined;
    /** Unix-seconds. Default `now + 3600`. */
    deadline?: bigint | undefined;
    /**
     * Native-ETH deposit. Requires the registered WETH asset id; SDK
     * calls `NativeAdapter.depositNative` with `msg.value = total`.
     */
    asEth?: boolean | undefined;
    /** Errors from callback are swallowed. */
    onPhase?: OnPhase<DepositPhase> | undefined;
}

/**
 * Unshield a WETH note to raw ETH via `NativeAdapter.withdrawNative`. The
 * pool is ERC-20 only, so the adapter drives the withdraw and unwraps the
 * proceeds. Asset id MUST be registered against the chain's WETH.
 */
export interface WithdrawEthOptions {
    /** L1 recipient of the unwrapped ETH. */
    to: EvmAddressLike;
    amount: AmountLike;
    /** WETH in the MASP registry, by id, token address or symbol. */
    asset: AssetRef;
    selectOpts?: SelectOpts | undefined;
    /** Self-spend then retry on `InsufficientCoverError`. */
    autoConsolidate?: boolean | undefined;
    onPhase?: OnPhase<SpendPhase> | undefined;
}

/**
 * Shielded transfer. Throws `InsufficientCoverError` if no 1- or 2-note
 * cover exists, unless `autoConsolidate: true`.
 */
export interface TransferOptions {
    /** Recipient shielded address. */
    to: ShieldedAddressLike;
    amount: AmountLike;
    /** Id, token address or symbol. Default asset 1. */
    asset?: AssetRef | undefined;
    /**
     * Asset to pay the relayer's shielded fee in. Defaults to the asset being
     * moved.
     *
     * A different asset costs two extra slots — an input note of that asset and
     * an output for its change — so it needs a circuit shape wide enough to
     * hold them: `nOut >= 4`, which the default 4×4 satisfies and a narrower
     * pool on `TRANSACT_3X3` does not. The relayer must also accept it:
     * `/chains` publishes the list, and one it does not quote is rejected
     * before any proving starts.
     */
    feeAsset?: AssetRef | undefined;
    selectOpts?: SelectOpts | undefined;
    autoConsolidate?: boolean | undefined;
    onPhase?: OnPhase<SpendPhase> | undefined;
}

/**
 * Unshield to ERC20. For native ETH use `withdrawEth`. Throws
 * `InsufficientCoverError` on no cover, unless `autoConsolidate: true`.
 */
export interface WithdrawOptions {
    /** L1 ERC-20 recipient. */
    to: EvmAddressLike;
    amount: AmountLike;
    /** Id, token address or symbol. Default asset 1. */
    asset?: AssetRef | undefined;
    /**
     * Asset to pay the relayer's shielded fee in. Defaults to the asset being
     * moved.
     *
     * A different asset costs two extra slots — an input note of that asset and
     * an output for its change — so it needs a circuit shape wide enough to
     * hold them: `nOut >= 4`, which the default 4×4 satisfies and a narrower
     * pool on `TRANSACT_3X3` does not. The relayer must also accept it:
     * `/chains` publishes the list, and one it does not quote is rejected
     * before any proving starts.
     */
    feeAsset?: AssetRef | undefined;
    selectOpts?: SelectOpts | undefined;
    autoConsolidate?: boolean | undefined;
    onPhase?: OnPhase<SpendPhase> | undefined;
}

/** Atomic shielded swap via SwapWrapper. */
export interface SwapOptions {
    assetIn: AssetRef;
    assetOut: AssetRef;
    /**
     * Gross publicOut in `assetIn`. MASP transfers `amount * scaleIn` minus
     * the protocol fee to the wrapper.
     */
    amount: AmountLike;
    /** Pre-fetched MetaQuoter quote pinning route + minOut. */
    quote: SwapQuote;
    /** SwapWrapper address; bound as leg-1 recipient+relayer and leg-2 payer. */
    wrapperAddress: EvmAddressLike;
    /** Shielded recipient for B note. Defaults to own. */
    bRecipient?: ShieldedAddress | undefined;
    /**
     * Asset to pay the relayer's shielded fee in. Defaults to the asset being
     * moved.
     *
     * A different asset costs two extra slots — an input note of that asset and
     * an output for its change — so it needs a circuit shape wide enough to
     * hold them: `nOut >= 4`, which the default 4×4 satisfies and a narrower
     * pool on `TRANSACT_3X3` does not. The relayer must also accept it:
     * `/chains` publishes the list, and one it does not quote is rejected
     * before any proving starts.
     */
    feeAsset?: AssetRef | undefined;
    selectOpts?: SelectOpts | undefined;
    autoConsolidate?: boolean | undefined;
    onPhase?: OnPhase<SpendPhase> | undefined;
}

/** Every field is optional; an empty filter returns every known note. */
export interface NotesFilter {
    /** Omit to read across every asset. */
    asset?: AssetIdLike | undefined;
    /** Omit to include both spent and unspent. */
    spent?: boolean | undefined;
}
