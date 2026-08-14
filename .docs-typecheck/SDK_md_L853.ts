import { shieldedExact, shieldedNetwork, unshieldedExact } from "@lelantos-org/sdk/x402";
export async function __block() {

const chainId = await wallet.chain.chainId();
client.register(shieldedNetwork(chainId), shieldedExact(wallet));
client.register(`eip155:${chainId}`,      unshieldedExact(wallet));
}
