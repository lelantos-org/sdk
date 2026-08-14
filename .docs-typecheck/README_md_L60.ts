import { connect, formatAmount, parseAmount } from "@lelantos-org/sdk";
export async function __block() {

const wallet = await connect({
    privateKey: privKeyHex,
    network: "anvil",
    rpcUrl: "http://localhost:8545",
});

const weth = await wallet.asset(1n);
await wallet.deposit({ asset: weth.id, amount: parseAmount("0.5", weth) });
await wallet.sync();
console.log(formatAmount(wallet.balance(weth.id), weth, { symbol: true }));
}
