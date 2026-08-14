// Domain structs -> viem ABI tuples.

import { bytesToHex } from "../../core/hex.js";
import type { AuxOutput, DepositRequest } from "../../protocol/deposit-request.js";

export function depositTuple(deposit: DepositRequest) {
    return {
        chainId: deposit.chainId,
        publicAssetId: deposit.publicAssetId,
        publicIn: deposit.publicIn,
        payer: deposit.payer as `0x${string}`,
        recipient: deposit.recipient as `0x${string}`,
        outCm: deposit.outCm as `0x${string}`,
        cvDep: deposit.cvDep,
        rcv: deposit.rcv,
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
