import { Wallet, type NetworkPreset } from "@lelantos-org/sdk";
export async function __block() {

const myChain: NetworkPreset = {
    chainId: 8453n,
    maspAddress: "0xMASP…",
    relayerAddress: "0xRelayer…",
    relayerUrl: "https://relayer.my-deployment.example",
    fmdUrl: "https://fmd.my-deployment.example",
    treeDepth: 10,
    permit2Address: "0x000000000022D473030F116dDEE9F6B43aC78BA3",  // optional
};

const wallet = await connect({ privateKey: pk, network: myChain, rpcUrl });
}
