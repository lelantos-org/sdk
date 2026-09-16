// Wallet capability checks.
//
// The guards in `chain/port.ts` apply to a chain adapter; these apply to a
// wallet. Both are `w is X` type predicates, so a narrowed caller gets the
// signing members typed and an un-narrowed caller cannot reach them.
//
// `deposit` and `cancelDeposit` remain on `WalletApi` for every wallet and throw
// `NoEvmAccountError` when the chain layer cannot sign. The compile-time boundary
// is `w.chain`, which is a `ChainReader` until one of these guards narrows it.
//
// Permit2 allowance checks go through the guards in `chain/port.ts` on
// `wallet.chain` directly, to keep a single way to ask each question.

import {
    type ChainAdapter,
    type NativeEthChain,
    supportsNativeEth,
    supportsSigning,
} from "../../chain/port.js";
import type { WalletApi } from "../api.js";

/**
 * A wallet whose chain layer holds a signing key and can therefore shield value
 * into the pool.
 *
 * Spending from the pool does not require this: a transfer, withdraw or swap
 * proves ownership in the circuit and the relayer broadcasts it and pays gas.
 * A deposit moves public tokens from an address that must hold them and pay
 * for the transaction. A wallet without a signer (e.g. passkey) supports every
 * operation except deposit.
 */
export type DepositCapableWallet = WalletApi & { readonly chain: ChainAdapter };

/**
 * Whether the wallet can deposit. Check before offering a deposit.
 *
 * `supportsSigning` in `chain/port.ts` is the equivalent check for a bare chain
 * layer.
 */
export function supportsDeposit(w: WalletApi): w is DepositCapableWallet {
    return supportsSigning(w.chain);
}

/**
 * A wallet that can deposit the native coin.
 *
 * `withdraw({ native: true })` is not gated by this: unshielding to ETH is a relayed spend that
 * only reads `nativeAdapterAddress`, so it is available to a wallet that cannot
 * sign.
 */
export type NativeDepositWallet = WalletApi & { readonly chain: NativeEthChain };

export function supportsNativeDeposit(w: WalletApi): w is NativeDepositWallet {
    return supportsNativeEth(w.chain);
}
