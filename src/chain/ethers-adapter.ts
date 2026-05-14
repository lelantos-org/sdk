// ethers v6 implementation of `ChainAdapter`. Class shell + thin
// delegators; per-concern logic lives in `./ethers/*.ts`.
//
// Layout:
//   - `./ethers/abi.ts`      — MASP + ERC20 ABI fragments
//   - `./ethers/internal.ts` — shared `bytesToHex`, `extractIntentId`, `safeOnSent`
//   - `./ethers/deposit.ts`  — `submitIntent` family
//   - `./ethers/permit2.ts`  — Permit2 sign/allowance/nonce
//   - `./ethers/reads.ts`    — chain queries (asset/feeBps/balance/etc.)
//   - `./ethers/cancel.ts`   — `cancelIntent`

import { Contract, JsonRpcProvider, type Signer, Wallet } from "ethers";
import {
    type AuxOutput,
    type DepositIntent,
    PERMIT2_ADDRESS,
    type Permit2Sig,
    type PermitSingle,
} from "../bundle/permit2.js";
import type {
    AssetEntry,
    CancelIntentInputs,
    ChainAdapter,
    EscrowedIntentView,
    IntentEscrowedRecord,
    Permit2SignArgs,
    TokenMeta,
} from "./adapter.js";
import { MASP_ABI } from "./ethers/abi.js";
import { cancelIntent as cancelIntentFn } from "./ethers/cancel.js";
import {
    submitIntentAuthorized as submitIntentAuthorizedFn,
    submitIntent as submitIntentFn,
    submitIntentNative as submitIntentNativeFn,
} from "./ethers/deposit.js";
import {
    permit2Allowance as permit2AllowanceFn,
    permit2Nonce as permit2NonceFn,
    permit2PermitAllowance as permit2PermitAllowanceFn,
    signPermit2AllowanceFn as signPermit2AllowanceImpl,
    signPermit2 as signPermit2Fn,
} from "./ethers/permit2.js";
import {
    cancelDelay as cancelDelayFn,
    chainId as chainIdFn,
    erc20Contract as erc20ContractFn,
    fetchAsset as fetchAssetFn,
    fetchFeeBps as fetchFeeBpsFn,
    fetchIntentEscrowed as fetchIntentEscrowedFn,
    getEscrowed as getEscrowedFn,
    nativeBalance as nativeBalanceFn,
    payerAddress as payerAddressFn,
    tokenAllowance as tokenAllowanceFn,
    tokenApprove as tokenApproveFn,
    tokenBalanceOf as tokenBalanceOfFn,
    tokenMeta as tokenMetaFn,
    waitTxReceipt as waitTxReceiptFn,
    wrapNative as wrapNativeFn,
} from "./ethers/reads.js";

export interface EthersChainAdapterOpts {
    rpcUrl: string;
    /// 0x-hex private key for the payer. Mutually exclusive with `signer`.
    signerKey?: string;
    /// Pre-built ethers Signer (e.g. wallet UI). Mutually exclusive with `signerKey`.
    signer?: Signer;
    maspAddress: string;
    /// Defaults to canonical CREATE2 deployment.
    permit2Address?: string;
    /// Override; otherwise read via `eth_chainId`.
    chainId?: bigint;
}

export class EthersChainAdapter implements ChainAdapter {
    readonly provider: JsonRpcProvider;
    readonly signer: Signer;
    /** @internal */
    readonly maspContract: Contract;
    /** @internal */
    readonly _maspAddress: string;
    /** @internal */
    readonly _permit2Address: string;
    /** @internal */
    readonly chainIdOverride?: bigint;
    /** @internal */
    cachedChainId?: bigint;

    constructor(opts: EthersChainAdapterOpts) {
        // Reuse caller-supplied provider verbatim: wrappers like
        // `ethers.NonceManager` track local nonce state that breaks if we
        // call `.connect(newProvider)`.
        const existing = (opts.signer as { provider?: unknown } | undefined)?.provider;
        if (opts.signer && existing instanceof JsonRpcProvider) {
            this.provider = existing;
            this.signer = opts.signer;
        } else {
            this.provider = new JsonRpcProvider(opts.rpcUrl);
            // ethers v6 default is 4s; drop for prompt receipt surfacing.
            this.provider.pollingInterval = 1000;
            if (opts.signer) {
                this.signer = trySignerConnect(opts.signer, this.provider);
            } else if (opts.signerKey) {
                this.signer = new Wallet(opts.signerKey, this.provider);
            } else {
                throw new Error("EthersChainAdapter: pass `signerKey` or `signer`");
            }
        }
        this._maspAddress = opts.maspAddress;
        this._permit2Address = opts.permit2Address ?? PERMIT2_ADDRESS;
        this.maspContract = new Contract(opts.maspAddress, MASP_ABI, this.provider);
        this.chainIdOverride = opts.chainId;
    }

    // ── reads ────────────────────────────────────────────────────────────
    chainId(): Promise<bigint> {
        return chainIdFn(this);
    }
    payerAddress(): Promise<string> {
        return payerAddressFn(this);
    }
    fetchAsset(id: bigint): Promise<AssetEntry> {
        return fetchAssetFn(this, id);
    }
    fetchFeeBps(): Promise<bigint> {
        return fetchFeeBpsFn(this);
    }
    getEscrowed(id: bigint): Promise<EscrowedIntentView | null> {
        return getEscrowedFn(this, id);
    }
    fetchIntentEscrowed(id: bigint): Promise<IntentEscrowedRecord | null> {
        return fetchIntentEscrowedFn(this, id);
    }
    cancelDelay(): Promise<number> {
        return cancelDelayFn(this);
    }
    erc20Contract(addr: string): Contract {
        return erc20ContractFn(this, addr);
    }
    tokenMeta(addr: string): Promise<TokenMeta> {
        return tokenMetaFn(this, addr);
    }
    tokenBalanceOf(addr: string, account: string): Promise<bigint> {
        return tokenBalanceOfFn(this, addr, account);
    }
    tokenAllowance(addr: string, owner: string, spender: string): Promise<bigint> {
        return tokenAllowanceFn(this, addr, owner, spender);
    }
    tokenApprove(
        addr: string,
        spender: string,
        amount: bigint,
        onTxHash?: (hash: string) => void,
    ): Promise<{ txHash: string }> {
        return tokenApproveFn(this, addr, spender, amount, onTxHash);
    }
    wrapNative(wethAddr: string, value: bigint): Promise<{ txHash: string }> {
        return wrapNativeFn(this, wethAddr, value);
    }
    waitTxReceipt(
        txHash: string,
        confirmations = 1,
    ): Promise<{ blockNumber: number; status: number }> {
        return waitTxReceiptFn(this, txHash, confirmations);
    }
    nativeBalance(account: string): Promise<bigint> {
        return nativeBalanceFn(this, account);
    }

    // ── deposit ──────────────────────────────────────────────────────────
    submitIntent(args: {
        intent: DepositIntent;
        permit2: Permit2Sig;
        aux: [AuxOutput, AuxOutput];
        onSent?: (txHash: string) => void;
    }): Promise<{ txHash: string; intentId: bigint }> {
        return submitIntentFn(this, args);
    }
    submitIntentNative(args: {
        intent: DepositIntent;
        aux: [AuxOutput, AuxOutput];
        value: bigint;
        onSent?: (txHash: string) => void;
    }): Promise<{ txHash: string; intentId: bigint }> {
        return submitIntentNativeFn(this, args);
    }
    submitIntentAuthorized(args: {
        intent: DepositIntent;
        aux: [AuxOutput, AuxOutput];
        onSent?: (txHash: string) => void;
    }): Promise<{ txHash: string; intentId: bigint }> {
        return submitIntentAuthorizedFn(this, args);
    }

    // ── permit2 ──────────────────────────────────────────────────────────
    signPermit2(args: Permit2SignArgs): Promise<Permit2Sig> {
        return signPermit2Fn(this, args);
    }
    signPermit2Allowance(permit: PermitSingle): Promise<{ signature: string }> {
        return signPermit2AllowanceImpl(this, permit);
    }
    permit2Allowance(
        token: string,
        owner: string,
        spender: string,
    ): Promise<{ amount: bigint; expiration: number; nonce: number }> {
        return permit2AllowanceFn(this, token, owner, spender);
    }
    permit2PermitAllowance(
        args: { owner: string; permit: PermitSingle; signature: string },
        onTxHash?: (hash: string) => void,
    ): Promise<{ txHash: string }> {
        return permit2PermitAllowanceFn(this, args, onTxHash);
    }
    permit2Nonce(): Promise<bigint> {
        return permit2NonceFn();
    }
    permit2Address(): string {
        return this._permit2Address;
    }

    // ── cancel ───────────────────────────────────────────────────────────
    cancelIntent(id: bigint, inputs: CancelIntentInputs): Promise<{ txHash: string }> {
        return cancelIntentFn(this, id, inputs);
    }

    // ── address accessors ────────────────────────────────────────────────
    /** @internal underlying MASP contract (helpers re-bind for writes). */
    get masp(): Contract {
        return this.maspContract;
    }
    async maspAddress(): Promise<string> {
        return this._maspAddress;
    }
    /** @internal sync variant for helpers that need it without awaiting. */
    maspAddressSync(): string {
        return this._maspAddress;
    }
}

function trySignerConnect(signer: Signer, provider: JsonRpcProvider): Signer {
    try {
        return signer.connect(provider);
    } catch (e) {
        const code = (e as { code?: string } | null)?.code;
        if (code === "UNSUPPORTED_OPERATION" && signer.provider) return signer;
        throw e;
    }
}
