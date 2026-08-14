import { formatAmount, formatUnits, minAmount, parseAmount, parseUnits } from "@lelantos-org/sdk";
export async function __block() {

const weth = await wallet.asset(1n);
// → { id: 1n, token: "0xC02a…", scale: 1000000000000000n, symbol: "WETH", decimals: 18 }

parseAmount("0.25", weth);                       // 250n     — human  → circuit
formatAmount(250n, weth, { symbol: true });      // "0.25 WETH" — circuit → human
minAmount(weth);                                 // "0.001"  — smallest expressible amount
}
