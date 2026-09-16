// A deposit escrow's cancel inputs, shared by `deposit` (from its receipt) and `cancelDeposit`
// (from the `DepositEscrowed` log it looks up).

import type { ChainReader } from "../../chain/port.js";
import type { CancelDepositInputs, DepositEscrowedRecord } from "../../chain/types.js";

/** The digest preimage `cancelDeposit` resupplies, from a `DepositEscrowed` record. */
export function cancelInputsOf(e: DepositEscrowedRecord): CancelDepositInputs {
    return Object.freeze({
        publicIn: e.publicIn,
        cm: e.cm,
        cvDep: [e.cvDep[0], e.cvDep[1]] as [bigint, bigint],
        publicAssetId: e.publicAssetId,
        feeBpsAtSubmit: e.feeBpsAtSubmit,
        payer: e.payer,
        submittedAt: e.submittedAt,
        feeIn: e.feeIn,
        feeAssetId: e.feeAssetId,
        feeCm: e.feeCm,
        feeCvDep: [e.feeCvDep[0], e.feeCvDep[1]] as [bigint, bigint],
    });
}

/**
 * Whether an escrow's digest-bound payer is `NativeAdapter`: such an escrow refunds only through
 * `cancelDepositNative`, since the pool would return the coin to the adapter.
 */
export function isNativeEscrowPayer(chain: ChainReader, payer: string): boolean {
    const adapter = chain.nativeAdapterAddress?.();
    return adapter !== undefined && adapter.toLowerCase() === payer.toLowerCase();
}
