// What a given wallet can do, asked before it is asked to do it.
//
// The chain-layer guards in `chain/port.ts` answer for an adapter; these
// answer for a wallet, which is the object a UI actually holds. The shape is
// deliberately the same — a `w is X` predicate rather than a boolean — so a
// caller that narrows gets the signing members typed, and one that does not
// cannot reach them by accident.
//
// Note what is *not* here. `deposit` and `cancelDeposit` stay on `WalletApi`
// for every wallet, and throw `DepositAdapterError` when the chain layer
// cannot sign. Making them optional would not bind: `Wallet` the class always
// declares them, so `connect(...).deposit()` would compile regardless, and the
// gate would only catch callers who happened to annotate `: WalletApi`. The
// honest compile-time boundary is `w.chain`, which is a `ChainReader` until
// one of these narrows it.
//
// Only the two questions callers actually ask live here. The Permit2 allowance
// paths are asked of `wallet.chain` directly through the guards in
// `chain/port.ts`; a wallet-level wrapper for them would be a second way to ask
// one question, and the second way is the one that drifts.

import {
    type ChainAdapter,
    type NativeEthChain,
    supportsNativeEth,
    supportsSigning,
} from "../chain/port.js";
import type { WalletApi } from "./api.js";
import type { SpendContext } from "./context.js";

/**
 * A wallet whose chain layer holds a signing key, and can therefore shield
 * value into the pool.
 *
 * Spending out of the pool needs none of this. A transfer, withdraw or swap
 * proves ownership in the circuit and hands the proof to the relayer, which
 * broadcasts it and pays the gas; a deposit moves public tokens out of an
 * address that must custody them and pay for the transaction itself. That is
 * the whole of the difference, and it is why a passkey wallet is a real
 * wallet with one operation missing rather than a degraded one.
 */
export type DepositCapableWallet = WalletApi & { readonly chain: ChainAdapter };

/**
 * The question to ask before offering a deposit.
 *
 * The entry point for anything holding a wallet — which is every application.
 * `supportsSigning` in `chain/port.ts` answers the same question one layer
 * down, for code holding a bare chain layer.
 */
export function supportsDeposit(w: WalletApi): w is DepositCapableWallet {
    return supportsSigning(w.chain);
}

/**
 * A wallet that can deposit the native coin.
 *
 * `withdrawEth` is deliberately not gated by this: unshielding to ETH is a
 * relayed spend that only reads `nativeAdapterAddress`, so it stays available
 * to a wallet that cannot sign.
 */
export type NativeDepositWallet = WalletApi & { readonly chain: NativeEthChain };

export function supportsNativeDeposit(w: WalletApi): w is NativeDepositWallet {
    return supportsNativeEth(w.chain);
}

/**
 * A spend context whose chain layer can sign.
 *
 * The executor counterpart of {@link DepositCapableWallet}. Narrowing the
 * context rather than passing the adapter alongside it is what keeps the two
 * from disagreeing: there is one chain layer, and `canDeposit` is the only way
 * to reach its signing half.
 */
export type DepositContext = SpendContext & {
    readonly cfg: SpendContext["cfg"] & { readonly chain: ChainAdapter };
};

export function canDeposit(ctx: SpendContext): ctx is DepositContext {
    return supportsSigning(ctx.cfg.chain);
}
