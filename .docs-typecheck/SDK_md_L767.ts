import { connect } from "@lelantos-org/sdk";
import { x402 }    from "@lelantos-org/sdk/x402";
export async function __block() {

const wallet = await connect({ mnemonic, network: "anvil", privateKey: privKeyHex, rpcUrl });
await wallet.sync();

const pay  = x402(wallet, { budget: { total: "5" } });
const data = await pay("https://api.example.com/premium").then((r) => r.json());
}
