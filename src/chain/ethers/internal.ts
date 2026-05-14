// Shared internals for the per-concern Ethers adapter helpers. Module
// access boundary is `EthersChainAdapter`; helpers receive the instance
// and use these accessors to reach private state without re-declaring it
// per file.
//
// `bytesToHex` / `extractIntentId` live here so both the deposit and
// permit2 helpers can use the same wire-encoding (and so `ethers-adapter`
// re-exports `bytesToHex` for `cancel`).

import type { Contract } from "ethers";
import { bytesToHex as bytesToHexImpl } from "../../utils/wire.js";
import { TxMiningError } from "../../wallet/errors/index.js";

/// Re-export of the shared wire helper. Kept here so per-concern files
/// import from one place per chain layer.
export const bytesToHex = bytesToHexImpl;

/// Walk the receipt logs for a MASP `IntentEscrowed` event and return its
/// indexed `id` field. Throws on missing receipt or missing event.
export function extractIntentId(
    receipt: { logs: ReadonlyArray<{ topics: ReadonlyArray<string>; data: string }> } | null,
    masp: Contract,
): bigint {
    if (!receipt) throw new TxMiningError("submitIntent: no receipt");
    const iface = masp.interface;
    for (const log of receipt.logs) {
        try {
            const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
            if (parsed?.name === "IntentEscrowed") return parsed.args[0] as bigint;
        } catch {
            // not a MASP log
        }
    }
    throw new TxMiningError("submitIntent: IntentEscrowed log not found");
}

/// Swallow throws from a user-supplied `onSent` callback.
export function safeOnSent(cb: ((hash: string) => void) | undefined, hash: string): void {
    if (!cb) return;
    try {
        cb(hash);
    } catch {
        // ignore
    }
}
