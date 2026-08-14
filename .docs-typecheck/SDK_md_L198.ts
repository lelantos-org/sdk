
export async function __block() {
const tx = await wallet.transfer({
    to: peerBech32,
    amount: 100n,
    asset: 1n,
    selectOpts: { dustThreshold: 10n },
    autoConsolidate: true,
});
// TransferResult: { kind: "transfer", txHash, commitments, nonZeroCommitments,
//                   ownCommitments, ownInflow, spent, inputSum, sent, change }
}
