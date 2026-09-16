// Relayer fee quotes and identities for tests.
//
// Not shipped: `src/**/*test-utils*` is excluded from the build, coverage and the layer check.

import { randomJubjubScalar } from "../core/random.js";
import { Jubjub } from "../crypto/jubjub-wasm/index.js";
import { Poseidon } from "../crypto/poseidon.js";
import { addressFromSpendingKey, buildSpendingKey } from "../keys/keys.js";
import type { EstimateResponse } from "../protocol/responses.js";

/** A fresh spending identity: its bech32m address and the viewing key that reads its notes. */
export async function identity(J?: Jubjub): Promise<{ address: string; ivk: bigint }> {
    const P = await Poseidon.build();
    const jubjub = J ?? (await Jubjub.build());
    const keys = buildSpendingKey(P, jubjub, randomJubjubScalar());
    return { address: addressFromSpendingKey(jubjub, keys), ivk: keys.ivk };
}

/** A fresh shielded address, e.g. standing in for a relayer's own. */
export async function freshAddress(J?: Jubjub): Promise<string> {
    return (await identity(J)).address;
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
