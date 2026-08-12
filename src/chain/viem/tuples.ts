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
        outCm: intent.outCm as `0x${string}`,
        cvDep: intent.cvDep,
        rcv: intent.rcv,
    };
}

export function auxTuple(a: AuxOutput) {
    return {
        clueRx: a.clueRx,
        clueRy: a.clueRy,
        ephPubX: a.ephPubX,
        ephPubY: a.ephPubY,
        ciphertext: bytesToHex(a.ciphertext) as `0x${string}`,
    };
}
