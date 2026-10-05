import { describe, expect, it, vi } from "vitest";
import { assetId, circuitAmount } from "../../core/brand.js";
import { NetworkError } from "../../errors/network.js";
import { TRANSACT_4X6 } from "../../protocol/shape.js";
import type { SubmitTransactPayload } from "../../protocol/transact.js";
import { makeTestCtx } from "../../test-utils/context.js";
import { estimateOf, freshAddress } from "../../test-utils/estimate.js";
import { storedNote } from "../../test-utils/wallet.js";
import { executeTransfer } from "../ops/transfer.js";

// A refused spend, rebuilt from the same notes. Whoever holds both attempts (the relayer, or
// anyone when the first reverted on chain) must not be able to match an output of one to an output
// of the other: a pad is addressed anew on every build, so an output that repeated would be known
// to pay someone.
//
// The output shuffle is pinned to the order the slots are assembled in, so every paying output
// keeps its slot, and with it its `rho`, between the attempts.
vi.mock("./outputs.js", async (importOriginal) => {
    const real = await importOriginal<typeof import("./outputs.js")>();
    return {
        ...real,
        finalizeSlots: (slots: Parameters<typeof real.finalizeSlots>[0]) =>
            real.finalizeSlots(slots, (n) => n - 1),
    };
});

const A1 = assetId(1n);

describe("a refused transfer, rebuilt from the same notes", () => {
    it("shares no output with the refused attempt", async () => {
        const relayer = await freshAddress();
        const recipient = await freshAddress();
        // One note in four input slots: three are dummies.
        const { ctx, submit, submitted, witness, markedSpent } = await makeTestCtx({
            notes: [storedNote("01", 100n)],
            shape: TRANSACT_4X6,
            estimate: estimateOf(relayer, { "1": 7n }),
        });
        const transfer = () =>
            executeTransfer(ctx, { asset: A1, recipient, amount: circuitAmount(30n) });

        submit.impl = async () => {
            throw new NetworkError("RELAYER_FAILED", "/v1/spend", "HTTP 400", { status: 400 });
        };
        await expect(transfer()).rejects.toMatchObject({ code: "RELAYER_REJECTED", status: 400 });
        const refusedWitness = witness.last as Record<string, string[]>;
        submit.impl = async () => ({ txHash: "0xdeadbeef" });
        await transfer();
        const landedWitness = witness.last as Record<string, string[]>;
        expect(markedSpent).toEqual([["01"]]);

        const [refused, landed] = submitted as [SubmitTransactPayload, SubmitTransactPayload];
        expect(submitted).toHaveLength(2);
        // The attempts spend the same note and pay the same values to the same keys from the same
        // slots, so every paying output has the `rho` it had before.
        expect(landed.pubInputs.nullifier[0]).toBe(refused.pubInputs.nullifier[0]);
        expect(landedWitness.out_value).toEqual(refusedWitness.out_value);
        expect(landedWitness.out_rho).toEqual(refusedWitness.out_rho);
        const paying = landedWitness.out_value!.flatMap((value, slot) =>
            value === "0" ? [] : [slot],
        );
        // The payee, two change notes and the relayer's fee; the last two slots are pads.
        expect(paying).toEqual([0, 1, 2, 3]);
        for (const slot of paying) {
            expect(landedWitness.out_pk![slot]).toBe(refusedWitness.out_pk![slot]);
        }

        const shared = <T>(a: readonly T[], b: readonly T[], key: (item: T) => string) => {
            const seen = new Set(a.map(key));
            return b.map(key).filter((k) => seen.has(k));
        };
        expect(shared(refused.pubInputs.outCm, landed.pubInputs.outCm, String)).toEqual([]);
        expect(shared(refused.aux, landed.aux, (a) => String(a.ephPub))).toEqual([]);
        expect(shared(refused.aux, landed.aux, (a) => String(a.clueR))).toEqual([]);
        expect(shared(refused.aux, landed.aux, (a) => String(a.ciphertext))).toEqual([]);
    });
});
