import { describe, expect, it, vi } from "vitest";
import { assetId, circuitAmount, type ShieldedAddress } from "../../core/brand.js";
import { InsufficientCoverError } from "../../errors/funds.js";
import { NetworkError } from "../../errors/network.js";
import type { Ladder } from "../../protocol/denominations.js";
import type { AssetInfo } from "../assets/index.js";
import type { TransferOptions } from "../types/options.js";
import type { TransferResult, WalletNote } from "../types/results.js";
import { type RedenominateHost, redenominate } from "./redenominate.js";

// A round tries ladder targets largest first and steps down only when a target does not fit the
// notes. Every other failure is real and must surface.

const ASSET = assetId(1n);
const LADDER = [100n, 200n, 500n] as unknown as Ladder;
const info = { id: ASSET, ladder: LADDER } as unknown as AssetInfo;

const note = (id: string, value: bigint): WalletNote =>
    ({ id, value, asset: ASSET, spent: false }) as unknown as WalletNote;

function host(transfer: (args: TransferOptions) => Promise<TransferResult>) {
    let notes = [note("a", 150n), note("b", 170n)];
    const h = {
        address: "lelantos1self" as ShieldedAddress,
        maxInputs: 4,
        notes: () => notes,
        transfer: vi.fn(async (args: TransferOptions) => {
            const result = await transfer(args);
            // The reshaped notes land on the ladder, so the next round finds nothing to do.
            notes = [note("c", 200n), note("d", 100n)];
            return result;
        }),
        awaitCommitments: vi.fn(async () => ({ status: "seen", missing: [], attempts: 0 })),
    };
    return h satisfies RedenominateHost;
}

const landed = { ownCommitments: ["0x01"], txHash: "0xabc" } as unknown as TransferResult;
const noCover = () =>
    new InsufficientCoverError({
        target: circuitAmount(200n),
        asset: ASSET,
        consolidate: [],
        consolidateSum: circuitAmount(0n),
        consolidationAttempted: false,
    });

describe("redenominate", () => {
    it("steps down to a smaller target when one does not fit", async () => {
        let calls = 0;
        const h = host(async () => {
            if (calls++ === 0) throw noCover();
            return landed;
        });

        expect(await redenominate(h, info)).toBe(1);
        expect(h.transfer.mock.calls.map(([a]) => a.amount)).toEqual([200n, 100n]);
    });

    it("surfaces a failure that is not about cover", async () => {
        const relayerDown = new NetworkError("RELAYER_FAILED", "/v1/spend", "HTTP 503", {
            status: 503,
        });
        const h = host(async () => {
            throw relayerDown;
        });

        // Swallowed, this read as "nothing left to reshape".
        await expect(redenominate(h, info)).rejects.toBe(relayerDown);
        expect(h.transfer).toHaveBeenCalledOnce();
    });

    it("never sends a second transfer when waiting for the first fails", async () => {
        const h = host(async () => landed);
        h.awaitCommitments.mockRejectedValueOnce(new Error("fmd down"));

        await expect(redenominate(h, info)).rejects.toThrow("fmd down");
        expect(h.transfer).toHaveBeenCalledOnce();
    });
});
