// Relayer fee quotes and addresses for tests.
//
// Not shipped: `src/**/*test-utils*` is excluded from the build, coverage and the layer check.

import { Jubjub } from "../crypto/jubjub-wasm/index.js";
import { Poseidon } from "../crypto/poseidon.js";
import type { EstimateResponse } from "../protocol/responses.js";
import { freshAccount } from "./outputs.js";

/** A fresh shielded address, e.g. standing in for a relayer's own. */
export async function freshAddress(J?: Jubjub): Promise<string> {
    return freshAccount(await Poseidon.build(), J ?? (await Jubjub.build())).address;
}

/**
 * A relayer quote charging `amounts` circuit units per asset id at `feeAddress`.
 *
 * Without `feeAddress` the relayer charges nothing: the quote carries no shielded fee address.
 */
export function estimateOf(
    feeAddress: string | undefined,
    amounts: Record<string, bigint> = {},
): EstimateResponse {
    return {
        gasUsed: 1,
        effectiveGasPriceWei: "1",
        totalNativeWei: "1",
        markupBps: 0,
        quotedAt: 0,
        ...(feeAddress !== undefined ? { shieldedFeeAddress: feeAddress } : {}),
        fees: Object.entries(amounts).map(([id, amount]) => ({
            tokenSymbol: `T${id}`,
            tokenAddress: "0x",
            decimals: 18,
            amount: amount.toString(),
            assetId: Number(id),
            circuitAmount: amount.toString(),
        })),
    };
}
