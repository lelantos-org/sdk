
export async function __block() {
const tx = await wallet.deposit({
    amount: 1000n,            // circuit units; on-chain inAmt = amount * scale
    asset: 1n,                // optional, default 1
    to: peerBech32,           // optional, default own address
    deadline: 1700000000n,    // optional permit expiry (default: now + 3600s)
    asEth: false,             // optional; true routes native ETH via NativeAdapter
    onPhase: (p) => console.log(p),   // "signing" | "submitting" | "broadcast" | "mined"
});
// DepositResult: { kind: "deposit", txHash, strategy, commitments,
//                  nonZeroCommitments, ownCommitments, ownInflow, sent, depositId? }
}
