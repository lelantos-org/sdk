// Concrete `ChainAdapter` implementation using ethers v6.
//
// Configures a `JsonRpcProvider` + private-key `Wallet`, exposes asset
// lookup via the MASP contract and EIP-2612 permit signing via the token
// contract. SDK already depends on ethers v6 (used by metamask + permit
// modules), so this is a free addition.

import { Contract, JsonRpcProvider, Wallet, type Signer } from "ethers";
import { signErc2612Permit, type Erc2612Permit } from "../../permit";
import type { AssetEntry, ChainAdapter, PermitSignArgs } from "../chain-adapter";

const MASP_ABI = [
    "function asset(uint64) view returns (address token, uint256 scale, uint256 genX, uint256 genY)",
    "function feeBps() view returns (uint16)",
    "function treasury() view returns (address)",
];

const ERC20_PERMIT_ABI = [
    "function name() view returns (string)",
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function nonces(address) view returns (uint256)",
];

export interface EthersChainAdapterOpts {
    rpcUrl: string;
    /// 0x-hex private key for the payer. Used to sign EIP-2612 permits.
    /// Pass an existing `ethers.Signer` via `signer` to keep keys outside
    /// SDK construction.
    signerKey?: string;
    /// Alternative: caller supplies a pre-built Signer (e.g. wallet UI).
    signer?: Signer;
    /// MASP contract address.
    maspAddress: string;
    /// Optional override; otherwise read via `eth_chainId`.
    chainId?: bigint;
}

export class EthersChainAdapter implements ChainAdapter {
    readonly provider: JsonRpcProvider;
    readonly signer: Signer;
    private readonly maspContract: Contract;
    private readonly _maspAddress: string;
    private readonly chainIdOverride?: bigint;
    private cachedChainId?: bigint;

    constructor(opts: EthersChainAdapterOpts) {
        this.provider = new JsonRpcProvider(opts.rpcUrl);
        if (opts.signer) {
            // Some signer implementations (e.g. ethers JsonRpcSigner backed
            // by a BrowserProvider) reject `.connect(provider)` with
            // UNSUPPORTED_OPERATION. In that case the signer is already
            // bound to its own provider, so use it as-is.
            this.signer = trySignerConnect(opts.signer, this.provider);
        } else if (opts.signerKey) {
            this.signer = new Wallet(opts.signerKey, this.provider);
        } else {
            throw new Error("EthersChainAdapter: pass `signerKey` or `signer`");
        }
        this._maspAddress = opts.maspAddress;
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
            genX: bigint;
            genY: bigint;
        };
        return { token: r.token, scale: r.scale, genX: r.genX, genY: r.genY };
    }

    async fetchFeeBps(): Promise<bigint> {
        return (await this.maspContract.feeBps()) as bigint;
    }

    async signPermit(args: PermitSignArgs): Promise<Erc2612Permit> {
        const token = new Contract(args.token, ERC20_PERMIT_ABI, this.provider);
        const tokenName = (await token.name()) as string;
        const payer = await this.payerAddress();
        const nonce = (await token.nonces(payer)) as bigint;
        const cid = await this.chainId();
        return signErc2612Permit({
            signer: this.signer,
            token: args.token,
            tokenName,
            chainId: cid,
            spender: args.spender,
            value: args.value,
            nonce,
            deadline: args.deadline,
        });
    }

    /// Bonus accessor; useful for CLI debug commands (balance, allowance).
    erc20Contract(addr: string): Contract {
        return new Contract(addr, ERC20_PERMIT_ABI, this.provider);
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
