import { connect, formatAmount, parseAmount } from "@lelantos-org/sdk";
export async function __block() {

const wallet = await connect({
    privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    network: "anvil",
    rpcUrl: "http://localhost:8545",
});

console.log("address:", wallet.address);

const weth = await wallet.asset(1n);                       // { id, token, scale, symbol, decimals }
await wallet.deposit({ asset: weth.id, amount: parseAmount("0.5", weth) });
await wallet.sync({ onProgress: (p) => console.log(p.phase, p.fetched) });
console.log("balance:", formatAmount(wallet.balance(weth.id), weth, { symbol: true }));

await wallet.transfer({ to: peerBech32, amount: 100n, asset: 1n, autoConsolidate: true });
await wallet.withdraw({ to: "0xf39…", amount: 200n, asset: 1n });
}
