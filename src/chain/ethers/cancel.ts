// `cancelIntent` — permissionless after `cancelDelay` blocks. Caller
// supplies the `IntentEscrowed` event payload for the on-chain digest
// check.

import type { Contract } from "ethers";
import type { CancelIntentInputs } from "../adapter.js";
import type { EthersChainAdapter } from "../ethers-adapter.js";

export async function cancelIntent(
    adapter: EthersChainAdapter,
    id: bigint,
    inputs: CancelIntentInputs,
): Promise<{ txHash: string }> {
    const masp = adapter.masp.connect(adapter.signer) as Contract;
    const tx = await masp.cancelIntent(
        id,
        inputs.publicIn,
        inputs.feeBpsAtSubmit,
        inputs.cm0,
        inputs.cm1,
        [inputs.cvDep0[0], inputs.cvDep0[1]],
        [inputs.cvDep1[0], inputs.cvDep1[1]],
    );
    await tx.wait();
    return { txHash: tx.hash as string };
}
