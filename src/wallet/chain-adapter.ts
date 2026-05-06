// Pluggable chain layer — abstracts the "talk to anvil" surface so that
// the high-level Wallet stays agnostic of the concrete RPC + signer stack.
//
// Implementations bridge a transport (ethers v6, viem, web3.js, custom)
// to: deposit-amount math (token + fee lookup) + EIP-2612 permit signing
// + payer eth address. The Wallet class consumes only this interface.

import type { Erc2612Permit } from "../permit.js";

export interface AssetEntry {
    token: string; // 0x ERC20 address
    scale: bigint; // multiplier from circuit-units to ERC20-base-units
    genX: bigint;
    genY: bigint;
}

export interface PermitSignArgs {
    /// ERC20 token contract address.
    token: string;
    /// MASP contract address (the spender being approved).
    spender: string;
    /// Approval amount in token base units. Should equal `inAmt + fee`.
    value: bigint;
    /// Unix-seconds expiry.
    deadline: bigint;
}

/// Display metadata for an ERC20 token. Returned by the optional
/// `tokenMeta` accessor on `ChainAdapter`. Used by CLIs/UIs that want to
/// render `valueOnchain` in human units.
export interface TokenMeta {
    symbol: string;
    decimals: number;
}

/// All chain-side operations the Wallet needs. Adapters MUST be deterministic
/// w.r.t. their constructor inputs (no hidden global state).
export interface ChainAdapter {
    chainId(): Promise<bigint>;
    /// Eth address of the signer (== `pi.payer` for deposit).
    payerAddress(): Promise<string>;
    /// MASP contract address. Used as the EIP-2612 permit `spender`.
    maspAddress(): Promise<string>;
    /// MASP.asset(id) — returns the registered token + scale + asset gen.
    fetchAsset(id: bigint): Promise<AssetEntry>;
    /// MASP.feeBps() — basis-point shield/unshield fee. 0 disables.
    fetchFeeBps(): Promise<bigint>;
    /// Sign EIP-2612 permit on the deposit token. Wallet bundles the result
    /// into the relayer payload; relayer routes to `transactWithPermit`.
    signPermit(args: PermitSignArgs): Promise<Erc2612Permit>;
    /// Read ERC20 `symbol()` + `decimals()` for `tokenAddr`. Optional:
    /// adapters that can't speak ERC20 (mocks, non-EVM) omit it. CLIs/UIs
    /// should feature-check before calling.
    tokenMeta?(tokenAddr: string): Promise<TokenMeta>;
    /// Read ERC20 `balanceOf(account)` for `tokenAddr`. Optional, same
    /// rationale as `tokenMeta`. Used by UIs to display the caller's
    /// transparent (unshielded) holdings alongside their note balances.
    tokenBalanceOf?(tokenAddr: string, account: string): Promise<bigint>;
    /// Native-asset (ETH) balance of `account`, in wei. Optional.
    nativeBalance?(account: string): Promise<bigint>;
}
