// A mined deposit as a chain adapter reports it, for deposit suites with stubbed chains.
//
// Not shipped: `src/**/*test-utils*` is excluded from the build, coverage and the layer check.

import type { DepositSubmitted } from "../chain/types.js";
import { type AssetId, branded, type EvmAddress, type Hex32 } from "../core/brand.js";
import type { DepositRequest } from "../protocol/deposit-request.js";

export const DEPOSIT_TX = branded<Hex32>(`0x${"11".repeat(32)}`);

/**
 * What `submitDeposit` (or the native / authorized path) resolves to once `deposit` is mined: the
 * `DepositEscrowed` payload the pool emits for exactly that request, at `block`.
 */
export function minedDeposit(
    deposit: DepositRequest,
    opts: { id?: bigint; block?: number; txHash?: Hex32 } = {},
): DepositSubmitted {
    const id = opts.id ?? 1n;
    const block = opts.block ?? 1_000;
    return {
        txHash: opts.txHash ?? DEPOSIT_TX,
        depositId: id,
        blockNumber: block,
        escrowed: {
            id,
            payer: branded<EvmAddress>(deposit.payer),
            recipient: branded<EvmAddress>(deposit.recipient),
            publicAssetId: branded<AssetId>(deposit.publicAssetId),
            publicIn: deposit.publicIn,
            feeBpsAtSubmit: 20,
            cm: branded<Hex32>(deposit.outCm),
            cvDep: deposit.cvDep,
            rcv: deposit.rcv,
            feeIn: deposit.feeIn,
            feeAssetId: branded<AssetId>(deposit.feeAssetId),
            feeCm: branded<Hex32>(deposit.feeCm),
            feeCvDep: deposit.feeCvDep,
            submittedAt: block,
        },
    };
}
