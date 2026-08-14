import { fetchSwapQuote } from "@lelantos-org/sdk/quoter";
export async function __block() {

const quote = await fetchSwapQuote(quoterUrl, {
    chainId,
    tokenIn,
    tokenOut,
    amountIn,
    slippageBps: 50,
});

await wallet.swap({
    assetIn: 1n,
    assetOut: 2n,
    amount: 100n,             // gross publicOut in circuit units of `assetIn`
    quote,                    // pins route + minOut
    wrapperAddress: "0xSwapWrapper…",
    bRecipient: peerBech32,   // optional, default own address
});
}
