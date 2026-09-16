import { describe, expect, it, vi } from "vitest";
import { circuitAmount, type ShieldedAddress } from "../../core/brand.js";
import type { AwaitCommitmentsResult } from "../notes/note-cache.js";
import type { SelectionResult } from "../selection/index.js";
import type { TransferOptions } from "../types/options.js";
import type { TransferResult } from "../types/results.js";
import { autoConsolidate, type ConsolidateHost } from "./consolidate.js";

// A consolidation is only useful once its merged note is stored: the caller's retry selects from
// the local note set.

const selection = {
    plan: "consolidate-first",
    consolidate: [
        { id: "a", value: "50" },
        { id: "b", value: "60" },
    ],
    consolidateSum: circuitAmount(110n),
} as unknown as Extract<SelectionResult, { plan: "consolidate-first" }>;

const SEEN: AwaitCommitmentsResult = { status: "seen", missing: [], attempts: 1 };

/**
 * A host whose pinned maximum is `110n - fee`, as `spendableMax` reports it over the two notes
 * above. `fee: 0n` covers both a relayer that charges nothing and one paid in another asset,
 * neither of which reserves anything from the merge.
 */
function host(waited: AwaitCommitmentsResult = SEEN, fee = 0n, max = 110n - fee) {
    return {
        address: "lelantos1self" as ShieldedAddress,
        maxInputs: 4,
        blockNumber: async () => undefined,
        storedNotes: () => [],
        spendableMax: vi.fn(async () => ({ max, fee })),
        transfer: vi.fn(
            async (_args: TransferOptions) =>
                ({
                    txHash: "0xabc",
                    ownCommitments: ["0x01", "0x02"],
                }) as unknown as TransferResult,
        ),
        awaitCommitments: vi.fn(async () => waited),
    } satisfies ConsolidateHost;
}

/** The amount and pinned ids the merge asked its transfer for. */
function sent(h: ReturnType<typeof host>) {
    return h.transfer.mock.calls[0]![0];
}

describe("autoConsolidate", () => {
    it("returns once the merged note is stored", async () => {
        const h = host();
        await expect(autoConsolidate(h, 1n, selection)).resolves.toBeUndefined();
        expect(h.transfer).toHaveBeenCalledOnce();
        // No fee reserved: the whole sum less the unit that keeps a change note.
        expect(sent(h)).toMatchObject({ amount: 109n, selection: { only: ["a", "b"] } });
    });

    it("sends what the pinned notes can move once the relayer's fee is reserved", async () => {
        const h = host(SEEN, 3n);
        await expect(autoConsolidate(h, 1n, selection)).resolves.toBeUndefined();
        // 110 pinned - 3 fee - 1 change. Asking for 109 would need 112 from notes worth 110.
        expect(sent(h)).toMatchObject({ amount: 106n, selection: { only: ["a", "b"] } });
        expect(h.spendableMax).toHaveBeenCalledWith(1n, ["a", "b"]);
    });

    it("refuses a merge the fee would eat, without sending it", async () => {
        const h = host(SEEN, 120n, 0n);
        await expect(autoConsolidate(h, 1n, selection)).rejects.toMatchObject({
            code: "INSUFFICIENT_BALANCE",
            asset: 1n,
            available: 110n,
            required: 121n,
            context: expect.objectContaining({ op: "consolidate" }),
        });
        // Nothing is proved or relayed, and nothing retries: no fee makes these notes reach it.
        expect(h.transfer).not.toHaveBeenCalled();
    });

    it("reports a merge whose note never got indexed", async () => {
        const h = host({ status: "timeout", missing: ["0x02"], attempts: 60 });

        // Ignored, the retry selects from the unmerged notes and reports insufficient cover.
        // NOTES_HELD, retryable: the merged value exists and is only waiting to be indexed.
        await expect(autoConsolidate(h, 1n, selection)).rejects.toMatchObject({
            code: "NOTES_HELD",
            retryable: true,
            asset: 1n,
            required: 110n,
            held: { reserved: { value: 110n, count: 1 } },
            context: expect.objectContaining({ op: "consolidate" }),
            details: expect.objectContaining({ txHash: "0xabc", missing: 1, attempts: 60 }),
        });
    });
});
