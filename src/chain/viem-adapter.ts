// viem-based `ChainAdapter` implementation. Single file — viem owns ABI
// encoding, log filtering, receipt polling, and signing primitives so the
// adapter stays thin.
//
// Inputs come in via an `EthSigner` (browser EIP-1193 wallet or Node
// private key — see `eth-signer.ts`) + a read RPC URL.

import {
    createPublicClient,
    decodeEventLog,
    encodeFunctionData,
    type Hex,
    http,
    type PublicClient,
    parseAbi,
    parseEventLogs,
    zeroAddress,
} from "viem";
import {
    type AuxOutput,
    type DepositIntent,
    PERMIT2_ADDRESS,
    type Permit2Sig,
    type PermitSingle,
    signPermit2Allowance,
    signPermit2Witness,
} from "../bundle/permit2.js";
import { bytesToHex } from "../utils/wire.js";
import { TxMiningError } from "../wallet/errors.js";
import type {
    AssetEntry,
    CancelIntentInputs,
    ChainAdapter,
    EscrowedIntentView,
    IntentEscrowedRecord,
    Permit2SignArgs,
    TokenMeta,
} from "./adapter.js";
import type { EthSigner } from "./eth-signer.js";

export const MASP_ABI = parseAbi([
    "function asset(uint64) view returns (address token, bool disabled, uint256 scale)",
    "function feeBps() view returns (uint16)",
    "function treasury() view returns (address)",
    "function cancelDelay() view returns (uint32)",
    "function WRAPPED_NATIVE() view returns (address)",
    "function nextIntentId() view returns (uint256)",
    "function escrowed(uint256) view returns (bytes32 digest, address payer, uint32 submittedAt, uint64 publicAssetId, uint16 feeBpsAtSubmit)",
    "function submitIntent((uint64 chainId,uint64 publicAssetId,uint64 publicIn,address payer,address recipient,bytes32[2] outCm,uint256[2] cvDep0,uint256[2] cvDep1,uint256 rcvTotal) d,(uint256 nonce,uint256 deadline,uint256 maxTotal,bytes signature) sig,(uint256 clueRx,uint256 clueRy,uint256 ephPubX,uint256 ephPubY,bytes ciphertext)[2] aux) returns (uint256)",
    "function submitIntentNative((uint64 chainId,uint64 publicAssetId,uint64 publicIn,address payer,address recipient,bytes32[2] outCm,uint256[2] cvDep0,uint256[2] cvDep1,uint256 rcvTotal) d,(uint256 clueRx,uint256 clueRy,uint256 ephPubX,uint256 ephPubY,bytes ciphertext)[2] aux) payable returns (uint256)",
    "function submitIntentAuthorized((uint64 chainId,uint64 publicAssetId,uint64 publicIn,address payer,address recipient,bytes32[2] outCm,uint256[2] cvDep0,uint256[2] cvDep1,uint256 rcvTotal) d,(uint256 clueRx,uint256 clueRy,uint256 ephPubX,uint256 ephPubY,bytes ciphertext)[2] aux) returns (uint256)",
    "function cancelIntent(uint256 id,uint48 publicIn,bytes32 cm0,bytes32 cm1,uint256[2] cvDep0,uint256[2] cvDep1)",
    "event IntentEscrowed(uint256 indexed id,address indexed payer,address indexed recipient,uint64 publicAssetId,uint64 publicIn,uint16 feeBpsAtSubmit,bytes32 cm0,bytes32 cm1,uint256 cvDep0X,uint256 cvDep0Y,uint256 cvDep1X,uint256 cvDep1Y,uint256 rcvTotal,uint256 clueRx0,uint256 clueRy0,uint256 ephPubX0,uint256 ephPubY0,bytes ciphertext0,uint256 clueRx1,uint256 clueRy1,uint256 ephPubX1,uint256 ephPubY1,bytes ciphertext1)",
    "event NotesCreated(bytes32 indexed cm0,bytes32 indexed cm1)",
    "event NotePayload(bytes32 indexed cm0,bytes32 indexed cm1,uint256 clueRx0,uint256 clueRy0,uint256 ephPubX0,uint256 ephPubY0,bytes ciphertext0,uint256 clueRx1,uint256 clueRy1,uint256 ephPubX1,uint256 ephPubY1,bytes ciphertext1,uint256 cvDep0X,uint256 cvDep0Y,uint256 cvDep1X,uint256 cvDep1Y)",
]);

const ERC20_ABI = parseAbi([
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address owner,address spender) view returns (uint256)",
    "function approve(address spender,uint256 amount) returns (bool)",
]);

const WETH_DEPOSIT_ABI = parseAbi(["function deposit() payable"]);

const PERMIT2_VIEW_ABI = parseAbi([
    "function allowance(address user,address token,address spender) view returns (uint160,uint48,uint48)",
]);

const PERMIT2_PERMIT_ABI = parseAbi([
    "function permit(address owner,((address token,uint160 amount,uint48 expiration,uint48 nonce) details,address spender,uint256 sigDeadline) permitSingle,bytes signature)",
]);

export interface ViemChainAdapterOpts {
    rpcUrl: string;
    signer: EthSigner;
    maspAddress: string;
    permit2Address?: string;
    chainId?: bigint;
}

export class ViemChainAdapter implements ChainAdapter {
    readonly publicClient: PublicClient;
    readonly signer: EthSigner;
    private readonly _maspAddress: `0x${string}`;
    private readonly _permit2Address: `0x${string}`;
    private readonly chainIdOverride?: bigint;
    private cachedChainId?: bigint;

    constructor(opts: ViemChainAdapterOpts) {
        this.publicClient = createPublicClient({ transport: http(opts.rpcUrl) });
        this.signer = opts.signer;
        this._maspAddress = opts.maspAddress as `0x${string}`;
        this._permit2Address = (opts.permit2Address ?? PERMIT2_ADDRESS) as `0x${string}`;
        this.chainIdOverride = opts.chainId;
    }

    // ── reads ────────────────────────────────────────────────────────────
    async chainId(): Promise<bigint> {
        if (this.chainIdOverride !== undefined) return this.chainIdOverride;
        if (this.cachedChainId !== undefined) return this.cachedChainId;
        this.cachedChainId = BigInt(await this.publicClient.getChainId());
        return this.cachedChainId;
    }

    async payerAddress(): Promise<string> {
        return this.signer.getAddress();
    }

    async fetchAsset(id: bigint): Promise<AssetEntry> {
        const [token, disabled, scale] = (await this.publicClient.readContract({
            address: this._maspAddress,
            abi: MASP_ABI,
            functionName: "asset",
            args: [id],
        })) as [string, boolean, bigint];
        return { token, scale, disabled };
    }

    async fetchFeeBps(): Promise<bigint> {
        const bps = (await this.publicClient.readContract({
            address: this._maspAddress,
            abi: MASP_ABI,
            functionName: "feeBps",
        })) as number;
        return BigInt(bps);
    }

    async getEscrowed(id: bigint): Promise<EscrowedIntentView | null> {
        const r = (await this.publicClient.readContract({
            address: this._maspAddress,
            abi: MASP_ABI,
            functionName: "escrowed",
            args: [id],
        })) as readonly [string, string, number, bigint, number];
        const [digest, payer, submittedAt, publicAssetId, feeBpsAtSubmit] = r;
        if (payer === zeroAddress) return null;
        return {
            digest,
            payer,
            submittedAt: Number(submittedAt),
            publicAssetId,
            feeBpsAtSubmit: Number(feeBpsAtSubmit),
        };
    }

    async fetchIntentEscrowed(
        id: bigint,
        fromBlock: bigint = 0n,
    ): Promise<IntentEscrowedRecord | null> {
        const event = MASP_ABI.find((a) => a.type === "event" && a.name === "IntentEscrowed") as
            | Extract<(typeof MASP_ABI)[number], { type: "event" }>
            | undefined;
        if (!event) throw new TxMiningError("fetchIntentEscrowed: ABI missing IntentEscrowed");
        const logs = await this.publicClient.getLogs({
            address: this._maspAddress,
            event,
            args: { id } as never,
            fromBlock,
            toBlock: "latest",
        });
        if (logs.length === 0) return null;
        const decoded = decodeEventLog({
            abi: MASP_ABI,
            data: logs[0].data,
            topics: logs[0].topics,
        });
        if (decoded.eventName !== "IntentEscrowed") return null;
        const a = decoded.args as unknown as Record<string, bigint | string>;
        return {
            id: a.id as bigint,
            payer: a.payer as string,
            recipient: a.recipient as string,
            publicAssetId: a.publicAssetId as bigint,
            publicIn: a.publicIn as bigint,
            feeBpsAtSubmit: Number(a.feeBpsAtSubmit as bigint),
            cm0: a.cm0 as string,
            cm1: a.cm1 as string,
            cvDep0: [a.cvDep0X as bigint, a.cvDep0Y as bigint],
            cvDep1: [a.cvDep1X as bigint, a.cvDep1Y as bigint],
            rcvTotal: a.rcvTotal as bigint,
        };
    }

    async cancelDelay(): Promise<number> {
        const r = (await this.publicClient.readContract({
            address: this._maspAddress,
            abi: MASP_ABI,
            functionName: "cancelDelay",
        })) as number;
        return Number(r);
    }

    async tokenMeta(addr: string): Promise<TokenMeta> {
        const [symbol, decimals] = await Promise.all([
            this.publicClient.readContract({
                address: addr as `0x${string}`,
                abi: ERC20_ABI,
                functionName: "symbol",
            }),
            this.publicClient.readContract({
                address: addr as `0x${string}`,
                abi: ERC20_ABI,
                functionName: "decimals",
            }),
        ]);
        return { symbol: symbol as string, decimals: Number(decimals) };
    }

    async tokenBalanceOf(addr: string, account: string): Promise<bigint> {
        return (await this.publicClient.readContract({
            address: addr as `0x${string}`,
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [account as `0x${string}`],
        })) as bigint;
    }

    async tokenAllowance(addr: string, owner: string, spender: string): Promise<bigint> {
        return (await this.publicClient.readContract({
            address: addr as `0x${string}`,
            abi: ERC20_ABI,
            functionName: "allowance",
            args: [owner as `0x${string}`, spender as `0x${string}`],
        })) as bigint;
    }

    async tokenApprove(
        addr: string,
        spender: string,
        amount: bigint,
        onTxHash?: (hash: string) => void,
    ): Promise<{ txHash: string }> {
        const data = encodeFunctionData({
            abi: ERC20_ABI,
            functionName: "approve",
            args: [spender as `0x${string}`, amount],
        });
        const hash = await this.signer.sendTransaction({ to: addr as `0x${string}`, data });
        onTxHash?.(hash);
        await this.waitTxReceipt(hash);
        return { txHash: hash };
    }

    async wrapNative(wethAddr: string, value: bigint): Promise<{ txHash: string }> {
        const data = encodeFunctionData({
            abi: WETH_DEPOSIT_ABI,
            functionName: "deposit",
        });
        const hash = await this.signer.sendTransaction({
            to: wethAddr as `0x${string}`,
            data,
            value,
        });
        await this.waitTxReceipt(hash);
        return { txHash: hash };
    }

    async waitTxReceipt(
        txHash: string,
        confirmations = 1,
    ): Promise<{ blockNumber: number; status: number }> {
        const receipt = await this.publicClient.waitForTransactionReceipt({
            hash: txHash as `0x${string}`,
            confirmations,
            pollingInterval: 1000,
        });
        return {
            blockNumber: Number(receipt.blockNumber),
            status: receipt.status === "success" ? 1 : 0,
        };
    }

    async nativeBalance(account: string): Promise<bigint> {
        return this.publicClient.getBalance({ address: account as `0x${string}` });
    }

    // ── deposit ──────────────────────────────────────────────────────────
    async submitIntent(args: {
        intent: DepositIntent;
        permit2: Permit2Sig;
        aux: [AuxOutput, AuxOutput];
        onSent?: (txHash: string) => void;
    }): Promise<{ txHash: string; intentId: bigint }> {
        const data = encodeFunctionData({
            abi: MASP_ABI,
            functionName: "submitIntent",
            args: [
                intentTuple(args.intent),
                {
                    nonce: args.permit2.nonce,
                    deadline: args.permit2.deadline,
                    maxTotal: args.permit2.maxTotal,
                    signature: args.permit2.signature as `0x${string}`,
                },
                auxTuples(args.aux),
            ] as never,
        });
        return this.sendAndExtractIntentId(data, args.onSent);
    }

    async submitIntentNative(args: {
        intent: DepositIntent;
        aux: [AuxOutput, AuxOutput];
        value: bigint;
        onSent?: (txHash: string) => void;
    }): Promise<{ txHash: string; intentId: bigint }> {
        const data = encodeFunctionData({
            abi: MASP_ABI,
            functionName: "submitIntentNative",
            args: [intentTuple(args.intent), auxTuples(args.aux)] as never,
        });
        return this.sendAndExtractIntentId(data, args.onSent, args.value);
    }

    async submitIntentAuthorized(args: {
        intent: DepositIntent;
        aux: [AuxOutput, AuxOutput];
        onSent?: (txHash: string) => void;
    }): Promise<{ txHash: string; intentId: bigint }> {
        const data = encodeFunctionData({
            abi: MASP_ABI,
            functionName: "submitIntentAuthorized",
            args: [intentTuple(args.intent), auxTuples(args.aux)] as never,
        });
        return this.sendAndExtractIntentId(data, args.onSent);
    }

    private async sendAndExtractIntentId(
        data: Hex,
        onSent?: (txHash: string) => void,
        value?: bigint,
    ): Promise<{ txHash: string; intentId: bigint }> {
        const hash = await this.signer.sendTransaction({
            to: this._maspAddress,
            data,
            value,
        });
        try {
            onSent?.(hash);
        } catch {
            // ignore user callback errors
        }
        const receipt = await this.publicClient.waitForTransactionReceipt({
            hash,
            pollingInterval: 1000,
        });
        const events = parseEventLogs({
            abi: MASP_ABI,
            eventName: "IntentEscrowed",
            logs: receipt.logs,
        });
        if (events.length === 0) {
            throw new TxMiningError("submitIntent: IntentEscrowed log not found");
        }
        const intentId = (events[0].args as { id: bigint }).id;
        return { txHash: hash, intentId };
    }

    // ── permit2 ──────────────────────────────────────────────────────────
    async signPermit2(args: Permit2SignArgs): Promise<Permit2Sig> {
        const cid = await this.chainId();
        return signPermit2Witness({
            signer: this.signer,
            chainId: cid,
            spender: this._maspAddress,
            token: args.token,
            maxTotal: args.maxTotal,
            nonce: args.nonce,
            deadline: args.deadline,
            piHash: args.piHash,
            permit2Address: this._permit2Address,
        });
    }

    async signPermit2Allowance(permit: PermitSingle): Promise<{ signature: string }> {
        const cid = await this.chainId();
        const r = await signPermit2Allowance({
            signer: this.signer,
            chainId: cid,
            permit,
            permit2Address: this._permit2Address,
        });
        return { signature: r.signature };
    }

    async permit2Allowance(
        token: string,
        owner: string,
        spender: string,
    ): Promise<{ amount: bigint; expiration: number; nonce: number }> {
        const r = (await this.publicClient.readContract({
            address: this._permit2Address,
            abi: PERMIT2_VIEW_ABI,
            functionName: "allowance",
            args: [owner as `0x${string}`, token as `0x${string}`, spender as `0x${string}`],
        })) as readonly [bigint, number, number];
        return { amount: r[0], expiration: Number(r[1]), nonce: Number(r[2]) };
    }

    async permit2PermitAllowance(
        args: { owner: string; permit: PermitSingle; signature: string },
        onTxHash?: (hash: string) => void,
    ): Promise<{ txHash: string }> {
        const data = encodeFunctionData({
            abi: PERMIT2_PERMIT_ABI,
            functionName: "permit",
            args: [
                args.owner as `0x${string}`,
                {
                    details: {
                        token: args.permit.details.token as `0x${string}`,
                        amount: args.permit.details.amount,
                        expiration: args.permit.details.expiration,
                        nonce: args.permit.details.nonce,
                    },
                    spender: args.permit.spender as `0x${string}`,
                    sigDeadline: args.permit.sigDeadline,
                },
                args.signature as `0x${string}`,
            ] as never,
        });
        const hash = await this.signer.sendTransaction({ to: this._permit2Address, data });
        onTxHash?.(hash);
        await this.waitTxReceipt(hash);
        return { txHash: hash };
    }

    async permit2Nonce(): Promise<bigint> {
        if (!globalThis.crypto?.getRandomValues) {
            throw new Error("Web Crypto API not available; provide a polyfill");
        }
        const bytes = new Uint8Array(32);
        globalThis.crypto.getRandomValues(bytes);
        let n = 0n;
        for (const b of bytes) n = (n << 8n) | BigInt(b);
        return n;
    }

    permit2Address(): string {
        return this._permit2Address;
    }

    // ── cancel ───────────────────────────────────────────────────────────
    async cancelIntent(id: bigint, inputs: CancelIntentInputs): Promise<{ txHash: string }> {
        const data = encodeFunctionData({
            abi: MASP_ABI,
            functionName: "cancelIntent",
            args: [
                id,
                inputs.publicIn,
                inputs.cm0 as `0x${string}`,
                inputs.cm1 as `0x${string}`,
                [inputs.cvDep0[0], inputs.cvDep0[1]],
                [inputs.cvDep1[0], inputs.cvDep1[1]],
            ] as never,
        });
        const hash = await this.signer.sendTransaction({ to: this._maspAddress, data });
        await this.waitTxReceipt(hash);
        return { txHash: hash };
    }

    // ── address accessors ────────────────────────────────────────────────
    async maspAddress(): Promise<string> {
        return this._maspAddress;
    }

    /** @internal */
    maspAddressSync(): string {
        return this._maspAddress;
    }
}

function intentTuple(intent: DepositIntent) {
    return {
        chainId: intent.chainId,
        publicAssetId: intent.publicAssetId,
        publicIn: intent.publicIn,
        payer: intent.payer as `0x${string}`,
        recipient: intent.recipient as `0x${string}`,
        outCm: intent.outCm as [`0x${string}`, `0x${string}`],
        cvDep0: intent.cvDep0,
        cvDep1: intent.cvDep1,
        rcvTotal: intent.rcvTotal,
    };
}

function auxTuples(aux: [AuxOutput, AuxOutput]) {
    return aux.map((a) => ({
        clueRx: a.clueRx,
        clueRy: a.clueRy,
        ephPubX: a.ephPubX,
        ephPubY: a.ephPubY,
        ciphertext: bytesToHex(a.ciphertext) as `0x${string}`,
    }));
}
