// `submitIntent*` family — three on-chain MASP entrypoints for the
// shielded-deposit escrow. All three resolve to `{ txHash, intentId }`
// once the `IntentEscrowed` event surfaces.

import type { Contract } from "ethers";
import type { AuxOutput, DepositIntent, Permit2Sig } from "../../bundle/permit2.js";
import type { EthersChainAdapter } from "../ethers-adapter.js";
import { bytesToHex, extractIntentId, safeOnSent } from "./internal.js";

function intentTuple(intent: DepositIntent) {
    return [
        intent.chainId,
        intent.publicAssetId,
        intent.publicIn,
        intent.payer,
        intent.recipient,
        intent.outCm,
        intent.cvDep0,
        intent.cvDep1,
        intent.rcvTotal,
    ];
}

function auxTuples(aux: [AuxOutput, AuxOutput]) {
    return aux.map((a) => [a.clueRx, a.clueRy, a.ephPubX, a.ephPubY, bytesToHex(a.ciphertext)]);
}

export async function submitIntent(
    adapter: EthersChainAdapter,
    args: {
        intent: DepositIntent;
        permit2: Permit2Sig;
        aux: [AuxOutput, AuxOutput];
        onSent?: (txHash: string) => void;
    },
): Promise<{ txHash: string; intentId: bigint }> {
    const masp = adapter.masp.connect(adapter.signer) as Contract;
    const { intent, permit2, aux } = args;
    const tx = await masp.submitIntent(
        intentTuple(intent),
        [permit2.nonce, permit2.deadline, permit2.maxTotal, permit2.signature],
        auxTuples(aux),
    );
    safeOnSent(args.onSent, tx.hash as string);
    const receipt = await tx.wait();
    const intentId = extractIntentId(receipt, adapter.masp);
    return { txHash: tx.hash as string, intentId };
}

export async function submitIntentNative(
    adapter: EthersChainAdapter,
    args: {
        intent: DepositIntent;
        aux: [AuxOutput, AuxOutput];
        value: bigint;
        onSent?: (txHash: string) => void;
    },
): Promise<{ txHash: string; intentId: bigint }> {
    const masp = adapter.masp.connect(adapter.signer) as Contract;
    const { intent, aux, value } = args;
    const tx = await masp.submitIntentNative(intentTuple(intent), auxTuples(aux), { value });
    safeOnSent(args.onSent, tx.hash as string);
    const receipt = await tx.wait();
    const intentId = extractIntentId(receipt, adapter.masp);
    return { txHash: tx.hash as string, intentId };
}

export async function submitIntentAuthorized(
    adapter: EthersChainAdapter,
    args: {
        intent: DepositIntent;
        aux: [AuxOutput, AuxOutput];
        onSent?: (txHash: string) => void;
    },
): Promise<{ txHash: string; intentId: bigint }> {
    const masp = adapter.masp.connect(adapter.signer) as Contract;
    const { intent, aux } = args;
    const tx = await masp.submitIntentAuthorized(intentTuple(intent), auxTuples(aux));
    safeOnSent(args.onSent, tx.hash as string);
    const receipt = await tx.wait();
    const intentId = extractIntentId(receipt, adapter.masp);
    return { txHash: tx.hash as string, intentId };
}
