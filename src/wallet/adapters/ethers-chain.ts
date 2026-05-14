// ethers v6 implementation of ChainAdapter.

import { Contract, JsonRpcProvider, type Signer, Wallet } from "ethers";
import {
    type AuxOutput,
    type DepositIntent,
    PERMIT2_ADDRESS,
    type Permit2Sig,
    type PermitSingle,
    signPermit2Allowance,
    signPermit2Witness,
} from "../../permit2.js";
import type {
    AssetEntry,
    CancelIntentInputs,
    ChainAdapter,
    EscrowedIntentView,
    IntentEscrowedRecord,
    Permit2SignArgs,
    TokenMeta,
} from "../chain-adapter.js";
import { TxMiningError } from "../errors.js";

const MASP_ABI = [
    "function asset(uint64) view returns (address token, uint256 scale)",
    "function feeBps() view returns (uint16)",
    "function treasury() view returns (address)",
    "function cancelDelay() view returns (uint32)",
    "function WETH() view returns (address)",
    "function nextIntentId() view returns (uint256)",
    "function escrowed(uint256) view returns (bytes32 digest, address payer, uint32 submittedAt, uint64 publicAssetId)",
    "function submitIntent((uint64 chainId,uint64 publicAssetId,uint64 publicIn,address payer,address recipient,bytes32[2] outCm,uint256[2] cvDep0,uint256[2] cvDep1,uint256 rcvTotal) d, (uint256 nonce,uint256 deadline,uint256 maxTotal,bytes signature) sig, (uint256 clueRx,uint256 clueRy,uint256 ephPubX,uint256 ephPubY,bytes ciphertext)[2] aux) returns (uint256)",
    "function submitIntentNative((uint64 chainId,uint64 publicAssetId,uint64 publicIn,address payer,address recipient,bytes32[2] outCm,uint256[2] cvDep0,uint256[2] cvDep1,uint256 rcvTotal) d, (uint256 clueRx,uint256 clueRy,uint256 ephPubX,uint256 ephPubY,bytes ciphertext)[2] aux) payable returns (uint256)",
    "function submitIntentAuthorized((uint64 chainId,uint64 publicAssetId,uint64 publicIn,address payer,address recipient,bytes32[2] outCm,uint256[2] cvDep0,uint256[2] cvDep1,uint256 rcvTotal) d, (uint256 clueRx,uint256 clueRy,uint256 ephPubX,uint256 ephPubY,bytes ciphertext)[2] aux) returns (uint256)",
    "function cancelIntent(uint256 id, uint48 publicIn, uint16 feeBpsAtSubmit, bytes32 cm0, bytes32 cm1, uint256[2] cvDep0, uint256[2] cvDep1)",
    "event IntentEscrowed(uint256 indexed id, address indexed payer, address indexed recipient, uint64 publicAssetId, uint64 publicIn, uint16 feeBpsAtSubmit, bytes32 cm0, bytes32 cm1, uint256 cvDep0X, uint256 cvDep0Y, uint256 cvDep1X, uint256 cvDep1Y, uint256 rcvTotal, uint256 clueRx0, uint256 clueRy0, uint256 ephPubX0, uint256 ephPubY0, bytes ciphertext0, uint256 clueRx1, uint256 clueRy1, uint256 ephPubX1, uint256 ephPubY1, bytes ciphertext1)",
    "event NotesCreated(bytes32 indexed cm0, bytes32 indexed cm1)",
    "event NotePayload(bytes32 indexed cm0, bytes32 indexed cm1, uint256 clueRx0, uint256 clueRy0, uint256 ephPubX0, uint256 ephPubY0, bytes ciphertext0, uint256 clueRx1, uint256 clueRy1, uint256 ephPubX1, uint256 ephPubY1, bytes ciphertext1, uint256 cvDep0X, uint256 cvDep0Y, uint256 cvDep1X, uint256 cvDep1Y)",
];

const ERC20_ABI = [
    "function name() view returns (string)",
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function nonces(address) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
];

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
    private readonly maspContract: Contract;
    private readonly _maspAddress: string;
    private readonly _permit2Address: string;
    private readonly chainIdOverride?: bigint;
    private cachedChainId?: bigint;

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

    async chainId(): Promise<bigint> {
        if (this.chainIdOverride !== undefined) return this.chainIdOverride;
        if (this.cachedChainId !== undefined) return this.cachedChainId;
        const net = await this.provider.getNetwork();
        this.cachedChainId = net.chainId;
        return this.cachedChainId;
    }

    async payerAddress(): Promise<string> {
        return this.signer.getAddress();
    }

    async fetchAsset(id: bigint): Promise<AssetEntry> {
        const r = (await this.maspContract.asset(id)) as {
            token: string;
            scale: bigint;
        };
        return { token: r.token, scale: r.scale };
    }

    async fetchFeeBps(): Promise<bigint> {
        return (await this.maspContract.feeBps()) as bigint;
    }

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

    async submitIntent(args: {
        intent: DepositIntent;
        permit2: Permit2Sig;
        aux: [AuxOutput, AuxOutput];
    }): Promise<{ txHash: string; intentId: bigint }> {
        const masp = this.maspContract.connect(this.signer) as Contract;
        const { intent, permit2, aux } = args;
        const tx = await masp.submitIntent(
            [
                intent.chainId,
                intent.publicAssetId,
                intent.publicIn,
                intent.payer,
                intent.recipient,
                intent.outCm,
                intent.cvDep0,
                intent.cvDep1,
                intent.rcvTotal,
            ],
            [permit2.nonce, permit2.deadline, permit2.maxTotal, permit2.signature],
            aux.map((a) => [a.clueRx, a.clueRy, a.ephPubX, a.ephPubY, bytesToHex(a.ciphertext)]),
        );
        const receipt = await tx.wait();
        const intentId = extractIntentId(receipt, this.maspContract);
        return { txHash: tx.hash as string, intentId };
    }

    async submitIntentNative(args: {
        intent: DepositIntent;
        aux: [AuxOutput, AuxOutput];
        value: bigint;
    }): Promise<{ txHash: string; intentId: bigint }> {
        const masp = this.maspContract.connect(this.signer) as Contract;
        const { intent, aux, value } = args;
        const tx = await masp.submitIntentNative(
            [
                intent.chainId,
                intent.publicAssetId,
                intent.publicIn,
                intent.payer,
                intent.recipient,
                intent.outCm,
                intent.cvDep0,
                intent.cvDep1,
                intent.rcvTotal,
            ],
            aux.map((a) => [a.clueRx, a.clueRy, a.ephPubX, a.ephPubY, bytesToHex(a.ciphertext)]),
            { value },
        );
        const receipt = await tx.wait();
        const intentId = extractIntentId(receipt, this.maspContract);
        return { txHash: tx.hash as string, intentId };
    }

    async submitIntentAuthorized(args: {
        intent: DepositIntent;
        aux: [AuxOutput, AuxOutput];
    }): Promise<{ txHash: string; intentId: bigint }> {
        const masp = this.maspContract.connect(this.signer) as Contract;
        const { intent, aux } = args;
        const tx = await masp.submitIntentAuthorized(
            [
                intent.chainId,
                intent.publicAssetId,
                intent.publicIn,
                intent.payer,
                intent.recipient,
                intent.outCm,
                intent.cvDep0,
                intent.cvDep1,
                intent.rcvTotal,
            ],
            aux.map((a) => [a.clueRx, a.clueRy, a.ephPubX, a.ephPubY, bytesToHex(a.ciphertext)]),
        );
        const receipt = await tx.wait();
        const intentId = extractIntentId(receipt, this.maspContract);
        return { txHash: tx.hash as string, intentId };
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
        const abi = [
            "function allowance(address user,address token,address spender) view returns (uint160,uint48,uint48)",
        ];
        const c = new Contract(this._permit2Address, abi, this.provider);
        const r = (await c.allowance(owner, token, spender)) as [bigint, bigint, bigint];
        return { amount: r[0], expiration: Number(r[1]), nonce: Number(r[2]) };
    }

    async permit2PermitAllowance(
        args: {
            owner: string;
            permit: PermitSingle;
            signature: string;
        },
        onTxHash?: (hash: string) => void,
    ): Promise<{ txHash: string }> {
        const abi = [
            "function permit(address owner,((address token,uint160 amount,uint48 expiration,uint48 nonce) details,address spender,uint256 sigDeadline) permitSingle,bytes signature)",
        ];
        const c = new Contract(this._permit2Address, abi, this.signer);
        const tx = await c.permit(
            args.owner,
            [
                [
                    args.permit.details.token,
                    args.permit.details.amount,
                    args.permit.details.expiration,
                    args.permit.details.nonce,
                ],
                args.permit.spender,
                args.permit.sigDeadline,
            ],
            args.signature,
        );
        onTxHash?.(tx.hash);
        const receipt = await tx.wait();
        if (!receipt) throw new TxMiningError("permit2PermitAllowance: no receipt");
        return { txHash: receipt.hash as string };
    }

    async cancelIntent(id: bigint, inputs: CancelIntentInputs): Promise<{ txHash: string }> {
        const masp = this.maspContract.connect(this.signer) as Contract;
        const tx = await masp.cancelIntent(
            id,
            inputs.publicIn,
            inputs.feeBpsAtSubmit,
            inputs.cm0,
            inputs.cm1,
            [inputs.cvDep0[0], inputs.cvDep0[1]],
            [inputs.cvDep1[0], inputs.cvDep1[1]],
        );
        await tx.wait();
        return { txHash: tx.hash as string };
    }

    async getEscrowed(id: bigint): Promise<EscrowedIntentView | null> {
        const r = (await this.maspContract.escrowed(id)) as {
            digest: string;
            payer: string;
            submittedAt: bigint;
            publicAssetId: bigint;
        };
        if (r.payer === "0x0000000000000000000000000000000000000000") return null;
        return {
            digest: r.digest,
            payer: r.payer,
            submittedAt: Number(r.submittedAt),
            publicAssetId: r.publicAssetId,
        };
    }

    /// Fetch + decode a single `IntentEscrowed` event by intent id. Null
    /// if no matching log. Populates `CancelIntentInputs` for `cancelIntent`.
    async fetchIntentEscrowed(id: bigint): Promise<IntentEscrowedRecord | null> {
        const iface = this.maspContract.interface;
        const topic = iface.getEvent("IntentEscrowed")?.topicHash;
        if (!topic) throw new TxMiningError("fetchIntentEscrowed: ABI missing IntentEscrowed");
        const idTopic = "0x" + id.toString(16).padStart(64, "0");
        const logs = await this.provider.getLogs({
            address: this._maspAddress,
            topics: [topic, idTopic],
            fromBlock: 0,
            toBlock: "latest",
        });
        if (logs.length === 0) return null;
        const parsed = iface.parseLog({ topics: [...logs[0].topics], data: logs[0].data });
        if (!parsed) return null;
        const a = parsed.args;
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
        const r = (await this.maspContract.cancelDelay()) as bigint;
        return Number(r);
    }

    /// Permit2 uses an unordered-nonce bitmap. Timestamp-derived word;
    /// collision odds negligible for human-rate signing. Override for
    /// stronger guarantees.
    async permit2Nonce(): Promise<bigint> {
        const word = BigInt(Date.now()) << 8n;
        return word | BigInt(Math.floor(Math.random() * 256));
    }

    erc20Contract(addr: string): Contract {
        return new Contract(addr, ERC20_ABI, this.provider);
    }

    async tokenMeta(tokenAddr: string): Promise<TokenMeta> {
        const c = this.erc20Contract(tokenAddr);
        const [sym, dec] = await Promise.all([c.symbol(), c.decimals()]);
        return { symbol: sym as string, decimals: Number(dec) };
    }

    async tokenBalanceOf(tokenAddr: string, account: string): Promise<bigint> {
        return (await this.erc20Contract(tokenAddr).balanceOf(account)) as bigint;
    }

    async tokenAllowance(tokenAddr: string, owner: string, spender: string): Promise<bigint> {
        return (await this.erc20Contract(tokenAddr).allowance(owner, spender)) as bigint;
    }

    async tokenApprove(
        tokenAddr: string,
        spender: string,
        amount: bigint,
        onTxHash?: (hash: string) => void,
    ): Promise<{ txHash: string }> {
        const c = this.erc20Contract(tokenAddr).connect(this.signer) as Contract;
        const tx = await c.approve(spender, amount);
        onTxHash?.(tx.hash);
        const receipt = await tx.wait();
        if (!receipt) throw new TxMiningError("tokenApprove: no receipt");
        return { txHash: receipt.hash as string };
    }

    permit2Address(): string {
        return this._permit2Address;
    }

    async wrapNative(wethAddr: string, value: bigint): Promise<{ txHash: string }> {
        const abi = ["function deposit() payable"];
        const c = new Contract(wethAddr, abi, this.signer);
        const tx = await c.deposit({ value });
        const receipt = await tx.wait();
        if (!receipt) throw new TxMiningError("wrapNative: no receipt");
        return { txHash: receipt.hash as string };
    }

    async waitTxReceipt(
        txHash: string,
        confirmations = 1,
    ): Promise<{ blockNumber: number; status: number }> {
        const receipt = await this.provider.waitForTransaction(txHash, confirmations);
        if (!receipt)
            throw new TxMiningError(`waitTxReceipt: no receipt for ${txHash}`, { txHash });
        return { blockNumber: receipt.blockNumber, status: receipt.status ?? 0 };
    }

    async nativeBalance(account: string): Promise<bigint> {
        return this.provider.getBalance(account);
    }

    get masp(): Contract {
        return this.maspContract;
    }

    async maspAddress(): Promise<string> {
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

function bytesToHex(b: Uint8Array): string {
    let h = "0x";
    for (const x of b) h += x.toString(16).padStart(2, "0");
    return h;
}

function extractIntentId(
    receipt: { logs: ReadonlyArray<{ topics: ReadonlyArray<string>; data: string }> } | null,
    masp: Contract,
): bigint {
    if (!receipt) throw new TxMiningError("submitIntent: no receipt");
    const iface = masp.interface;
    for (const log of receipt.logs) {
        try {
            const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
            if (parsed?.name === "IntentEscrowed") return parsed.args[0] as bigint;
        } catch {
            // not a MASP log
        }
    }
    throw new TxMiningError("submitIntent: IntentEscrowed log not found");
}
