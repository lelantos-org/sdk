// Pluggable chain layer — abstracts the "talk to anvil" surface so that
// the high-level Wallet stays agnostic of the concrete RPC + signer stack.
//
// Implementations bridge a transport (ethers v6, viem, web3.js, custom)
// to: asset/fee lookup, Permit2 witness signing for deposits,
// `cancelIntent` broadcasting, and `escrowed(id)` reads.

import type { AuxOutput, DepositIntent, Permit2Sig, PermitSingle } from "../permit2.js";

export interface AssetEntry {
    token: string; // 0x ERC20 address
    scale: bigint; // multiplier from circuit-units to ERC20-base-units
}

export interface Permit2SignArgs {
    /// ERC-20 being pulled into escrow.
    token: string;
    /// Caller's ceiling on `inAmt + fee` in token base units. Bound into
    /// the Permit2 sig as `permitted.amount`.
    maxTotal: bigint;
    /// Unix-seconds expiry.
    deadline: bigint;
    /// DepositIntent + AuxValidation.Output[2] hash (binds the sig to a
    /// specific deposit; mirrors `keccak256(abi.encode(d, aux))` on-chain).
    piHash: string;
    /// Permit2 nonce — the wallet picks a fresh value (Permit2 uses an
    /// unordered bitmap, not a sequential nonce).
    nonce: bigint;
}

/// Pending intent record returned by `MASP.escrowed(id)`. Fields mirror
/// the on-chain `EscrowedIntent` struct.
export interface EscrowedIntentView {
    cm0: string; // 0x-hex 32 B
    cm1: string;
    payer: string;
    submittedAt: number; // block number of submitIntent
    publicIn: bigint;
    feeBpsAtSubmit: number;
    publicAssetId: bigint;
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
    /// MASP contract address. Used as the Permit2 `spender`.
    maspAddress(): Promise<string>;
    /// MASP.asset(id) — returns the registered token + scale + asset gen.
    fetchAsset(id: bigint): Promise<AssetEntry>;
    /// MASP.feeBps() — basis-point shield/unshield fee. 0 disables.
    fetchFeeBps(): Promise<bigint>;
    /// Sign a Permit2 `PermitWitnessTransferFrom` for the deposit token,
    /// witness-bound to `piHash = keccak256(abi.encode(DepositIntent, aux))`.
    /// MASP._permit2Pull replays this on-chain via Permit2.
    signPermit2(args: Permit2SignArgs): Promise<Permit2Sig>;
    /// Build + sign + broadcast `MASP.submitIntent(d, sig, aux)`. Returns
    /// the on-chain tx hash and the allocated intent id (read from the
    /// `IntentEscrowed` log). Optional: adapters that only sign (and let
    /// the relayer broadcast) may omit it.
    submitIntent?(args: {
        intent: DepositIntent;
        permit2: Permit2Sig;
        aux: [AuxOutput, AuxOutput];
    }): Promise<{ txHash: string; intentId: bigint }>;
    /// Build + sign + broadcast `MASP.submitIntentNative(d, aux)` with
    /// `msg.value = value`. Pool wraps internally — no Permit2, no separate
    /// wrap tx. Caller must already have routed the deposit through the
    /// WETH-registered asset id. Optional.
    submitIntentNative?(args: {
        intent: DepositIntent;
        aux: [AuxOutput, AuxOutput];
        value: bigint;
    }): Promise<{ txHash: string; intentId: bigint }>;
    /// Build + sign + broadcast `MASP.submitIntentAuthorized(d, aux)`. Pulls
    /// via Permit2 `IAllowanceTransfer.transferFrom` against a previously-
    /// signed allowance window — no per-deposit Permit2 sig. Caller must
    /// have invoked `permit2PermitAllowance` once with sufficient cap +
    /// expiration covering this pull. Optional.
    submitIntentAuthorized?(args: {
        intent: DepositIntent;
        aux: [AuxOutput, AuxOutput];
    }): Promise<{ txHash: string; intentId: bigint }>;
    /// Read `IAllowanceTransfer.allowance(owner, token, spender)` —
    /// remaining cap, expiry, and current nonce. Optional.
    permit2Allowance?(
        token: string,
        owner: string,
        spender: string,
    ): Promise<{ amount: bigint; expiration: number; nonce: number }>;
    /// Submit a pre-signed `PermitSingle` via `IAllowanceTransfer.permit`.
    /// Tx — anyone can submit; relayer-gasless variants may override.
    /// Optional.
    permit2PermitAllowance?(
        args: {
            owner: string;
            permit: PermitSingle;
            signature: string;
        },
        onTxHash?: (hash: string) => void,
    ): Promise<{ txHash: string }>;
    /// Sign a `PermitSingle` for AllowanceTransfer-mode deposits. The
    /// adapter owns the signer; webapp/CLIs call this once per
    /// (token, expiration) window. Optional.
    signPermit2Allowance?(permit: PermitSingle): Promise<{ signature: string }>;
    /// Broadcast `MASP.cancelIntent(id)`. Returns tx hash. Optional —
    /// adapters that don't speak EVM may omit it.
    cancelIntent?(id: bigint): Promise<{ txHash: string }>;
    /// Read `MASP.escrowed(id)` — null if the intent was already flushed
    /// or cancelled (zero payer field). Optional.
    getEscrowed?(id: bigint): Promise<EscrowedIntentView | null>;
    /// Read `MASP.cancelDelay()` — blocks before `cancelIntent` is
    /// allowed. Optional.
    cancelDelay?(): Promise<number>;
    /// Token's Permit2 nonce for the payer. Permit2 uses an unordered
    /// nonce bitmap; wallets must read or generate a free slot. Optional —
    /// adapters that hand back a deterministic nonce can omit it.
    permit2Nonce?(): Promise<bigint>;
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
    /// Read ERC20 allowance(owner, spender). Optional.
    tokenAllowance?(tokenAddr: string, owner: string, spender: string): Promise<bigint>;
    /// Send ERC20 approve(spender, amount) from the signer. Optional.
    tokenApprove?(
        tokenAddr: string,
        spender: string,
        amount: bigint,
        onTxHash?: (hash: string) => void,
    ): Promise<{ txHash: string }>;
    /// Address of the Permit2 contract this adapter is configured against.
    /// Optional — adapters that don't use Permit2 omit it.
    permit2Address?(): string;
    /// Wrap raw native asset into its WETH-style ERC20 by calling
    /// `WETH9.deposit{value}` on `wethAddr`. Returns the on-chain tx hash.
    /// Optional — non-EVM adapters or adapters without a wrapped-native
    /// token omit it.
    wrapNative?(wethAddr: string, value: bigint): Promise<{ txHash: string }>;
    /// Block until `txHash` reaches `confirmations` confirmations. Returns
    /// the mining block number + receipt status (1 = success, 0 = revert).
    /// Optional; UIs that want a "mined" toast can call this after submit.
    waitTxReceipt?(
        txHash: string,
        confirmations?: number,
    ): Promise<{ blockNumber: number; status: number }>;
}

// ============================================================================
// Capability detection — additive helpers over the optional ChainAdapter
// methods so callers can ask "does this adapter support X?" without manually
// poking 4 fields. Predicates narrow the type via `is` so subsequent calls
// are non-null without `!`.
// ============================================================================

/// Required-method core. Every adapter provides at least these.
export type CoreChain = Pick<
    ChainAdapter,
    "chainId" | "payerAddress" | "maspAddress" | "fetchAsset" | "fetchFeeBps" | "signPermit2"
>;

/// Permit2 SignatureTransfer (witness) deposit path. The original flow.
export type Permit2WitnessChain = ChainAdapter &
    Required<Pick<ChainAdapter, "submitIntent" | "signPermit2">>;

/// Permit2 AllowanceTransfer (Phase 2) deposit path. One-time signed window
/// covers N future deposits.
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

/// Native-ETH (Phase 1) deposit path. Pool wraps msg.value internally.
export type NativeEthChain = ChainAdapter & Required<Pick<ChainAdapter, "submitIntentNative">>;

/// True when the adapter implements every method needed for the Permit2
/// AllowanceTransfer flow (read state + sign + submit permit + authorized
/// deposit).
export function supportsAllowanceTransfer(c: ChainAdapter): c is AllowanceTransferChain {
    return (
        !!c.submitIntentAuthorized &&
        !!c.permit2Allowance &&
        !!c.permit2PermitAllowance &&
        !!c.signPermit2Allowance
    );
}

/// True when the adapter exposes the native-ETH deposit entrypoint.
export function supportsNativeEth(c: ChainAdapter): c is NativeEthChain {
    return !!c.submitIntentNative;
}

/// True when the adapter exposes the legacy witness-mode deposit + signer.
export function supportsPermit2Witness(c: ChainAdapter): c is Permit2WitnessChain {
    return !!c.submitIntent && !!c.signPermit2;
}
