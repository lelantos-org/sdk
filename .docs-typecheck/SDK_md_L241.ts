
export async function __block() {
await wallet.withdrawEth({ to: "0xf39…", amount: 200n, asset: 1n });
}
