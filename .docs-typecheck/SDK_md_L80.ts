import { connect, generateMnemonic, isValidMnemonic } from "@lelantos-org/sdk";
export async function __block() {

const mnemonic = generateMnemonic({ words: 24 });
if (!isValidMnemonic(mnemonic)) throw new Error("bad seed");

const wallet = await connect({
    mnemonic,
    network: "anvil",
    privateKey: "0x...",
    rpcUrl: "http://localhost:8545",
    account: 0,
});
}
