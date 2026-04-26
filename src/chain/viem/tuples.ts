// Domain structs -> viem ABI tuples.

import { bytesToHex } from "../../core/hex.js";
import type { AuxOutput, DepositIntent } from "../../protocol/deposit-intent.js";

export function intentTuple(intent: DepositIntent) {
    return {
        chainId: intent.chainId,
        publicAssetId: intent.publicAssetId,
        publicIn: intent.publicIn,
        payer: intent.payer as `0x${string}`,
        recipient: intent.recipient as `0x${string}`,
        outCm: intent.outCm as [`0x${string}`, `0x${string}`],
        cvDep0: intent.cvDep0,
        cvDep1: intent.cvDep1,
        rcvTotal: intent.rcvTotal,
    };
}

export function auxTuples(aux: [AuxOutput, AuxOutput]) {
    return aux.map((a) => ({
        clueRx: a.clueRx,
        clueRy: a.clueRy,
        ephPubX: a.ephPubX,
        ephPubY: a.ephPubY,
        ciphertext: bytesToHex(a.ciphertext) as `0x${string}`,
    }));
}
