// Wallet capability guards: the wallet-level counterparts of the chain guards in `chain/port.ts`.
// Both are type predicates, so only a narrowed caller reaches the signing members.
//
// `deposit` and `cancelDeposit` remain on `WalletApi` for every wallet and throw
// `NoEvmAccountError` when the chain layer cannot sign. The compile-time boundary is `w.chain`, a
// `ChainReader` until one of these guards narrows it. Permit2 allowance checks use the
// `chain/port.ts` guards on `wallet.chain` directly.

import {
    type ChainAdapter,
    type NativeEthChain,
    supportsNativeEth,
    supportsSigning,
} from "../../chain/port.js";
import type { WalletApi } from "../api.js";

/**
 * A wallet whose chain layer holds a signing key and can therefore shield value into the pool.
 *
 * Spending from the pool does not require this: a transfer, withdraw or swap proves ownership in
 * the circuit, and the relayer broadcasts it and pays gas. A deposit moves public tokens from an
 * address that must hold them and pay for the transaction, so a wallet without a signer (e.g.
 * passkey) supports every operation except deposit.
 */
export type DepositCapableWallet = WalletApi & { readonly chain: ChainAdapter };

/**
 * Whether the wallet can deposit. Check before offering a deposit. `supportsSigning` is the
 * equivalent check for a bare chain layer.
 */
export function supportsDeposit(w: WalletApi): w is DepositCapableWallet {
    return supportsSigning(w.chain);
}

/**
 * A wallet that can deposit the native coin.
 *
 * `withdraw({ native: true })` is not gated by this: unshielding to ETH is a relayed spend that
 * only reads `nativeAdapterAddress`, so a wallet that cannot sign can do it.
 */
export type NativeDepositWallet = WalletApi & { readonly chain: NativeEthChain };

export function supportsNativeDeposit(w: WalletApi): w is NativeDepositWallet {
    return supportsNativeEth(w.chain);
}
