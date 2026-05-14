// Read-only chain queries: chain id, payer/MASP addresses, asset
// registry, fee bps, escrow lookups, ERC-20 metadata, native balance.

import { Contract } from "ethers";
import { TxMiningError } from "../../wallet/errors/index.js";
import type {
    AssetEntry,
    EscrowedIntentView,
    IntentEscrowedRecord,
    TokenMeta,
} from "../adapter.js";
import type { EthersChainAdapter } from "../ethers-adapter.js";
import { ERC20_ABI } from "./abi.js";

export async function chainId(adapter: EthersChainAdapter): Promise<bigint> {
    if (adapter.chainIdOverride !== undefined) return adapter.chainIdOverride;
    if (adapter.cachedChainId !== undefined) return adapter.cachedChainId;
    const net = await adapter.provider.getNetwork();
    adapter.cachedChainId = net.chainId;
    return adapter.cachedChainId;
}

export async function payerAddress(adapter: EthersChainAdapter): Promise<string> {
    return adapter.signer.getAddress();
}

export async function fetchAsset(adapter: EthersChainAdapter, id: bigint): Promise<AssetEntry> {
    const r = (await adapter.masp.asset(id)) as { token: string; scale: bigint };
    return { token: r.token, scale: r.scale };
}

export async function fetchFeeBps(adapter: EthersChainAdapter): Promise<bigint> {
    return (await adapter.masp.feeBps()) as bigint;
}

export async function getEscrowed(
    adapter: EthersChainAdapter,
    id: bigint,
): Promise<EscrowedIntentView | null> {
    const r = (await adapter.masp.escrowed(id)) as {
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

/// Fetch + decode a single `IntentEscrowed` event by intent id. Null if
/// no matching log. Populates `CancelIntentInputs` for `cancelIntent`.
export async function fetchIntentEscrowed(
    adapter: EthersChainAdapter,
    id: bigint,
): Promise<IntentEscrowedRecord | null> {
    const iface = adapter.masp.interface;
    const topic = iface.getEvent("IntentEscrowed")?.topicHash;
    if (!topic) throw new TxMiningError("fetchIntentEscrowed: ABI missing IntentEscrowed");
    const idTopic = `0x${id.toString(16).padStart(64, "0")}`;
    const logs = await adapter.provider.getLogs({
        address: adapter.maspAddressSync(),
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

export async function cancelDelay(adapter: EthersChainAdapter): Promise<number> {
    const r = (await adapter.masp.cancelDelay()) as bigint;
    return Number(r);
}

export function erc20Contract(adapter: EthersChainAdapter, addr: string): Contract {
    return new Contract(addr, ERC20_ABI, adapter.provider);
}

export async function tokenMeta(adapter: EthersChainAdapter, addr: string): Promise<TokenMeta> {
    const c = erc20Contract(adapter, addr);
    const [sym, dec] = await Promise.all([c.symbol(), c.decimals()]);
    return { symbol: sym as string, decimals: Number(dec) };
}

export async function tokenBalanceOf(
    adapter: EthersChainAdapter,
    addr: string,
    account: string,
): Promise<bigint> {
    return (await erc20Contract(adapter, addr).balanceOf(account)) as bigint;
}

export async function tokenAllowance(
    adapter: EthersChainAdapter,
    addr: string,
    owner: string,
    spender: string,
): Promise<bigint> {
    return (await erc20Contract(adapter, addr).allowance(owner, spender)) as bigint;
}

export async function tokenApprove(
    adapter: EthersChainAdapter,
    addr: string,
    spender: string,
    amount: bigint,
    onTxHash?: (hash: string) => void,
): Promise<{ txHash: string }> {
    const c = erc20Contract(adapter, addr).connect(adapter.signer) as Contract;
    const tx = await c.approve(spender, amount);
    onTxHash?.(tx.hash);
    const receipt = await tx.wait();
    if (!receipt) throw new TxMiningError("tokenApprove: no receipt");
    return { txHash: receipt.hash as string };
}

export async function wrapNative(
    adapter: EthersChainAdapter,
    wethAddr: string,
    value: bigint,
): Promise<{ txHash: string }> {
    const abi = ["function deposit() payable"];
    const c = new Contract(wethAddr, abi, adapter.signer);
    const tx = await c.deposit({ value });
    const receipt = await tx.wait();
    if (!receipt) throw new TxMiningError("wrapNative: no receipt");
    return { txHash: receipt.hash as string };
}

export async function waitTxReceipt(
    adapter: EthersChainAdapter,
    txHash: string,
    confirmations = 1,
): Promise<{ blockNumber: number; status: number }> {
    const receipt = await adapter.provider.waitForTransaction(txHash, confirmations);
    if (!receipt) throw new TxMiningError(`waitTxReceipt: no receipt for ${txHash}`, { txHash });
    return { blockNumber: receipt.blockNumber, status: receipt.status ?? 0 };
}

export async function nativeBalance(adapter: EthersChainAdapter, account: string): Promise<bigint> {
    return adapter.provider.getBalance(account);
}
