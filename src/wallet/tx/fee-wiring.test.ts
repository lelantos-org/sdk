import { describe, expect, it } from "vitest";
import { circuitAmount } from "../../core/brand.js";
import { decodeNotePayload, stripClueBitsPrefix } from "../../notes/codec.js";
import { decryptNote } from "../../notes/encrypt.js";
import type { EstimateResponse } from "../../protocol/responses.js";
import { TRANSACT_4X6 } from "../../protocol/shape.js";
import type { SubmitTransactPayload } from "../../protocol/transact.js";
import { makeTestCtx } from "../../test-utils/context.js";
import { estimateOf, freshAddress, identity } from "../../test-utils/estimate.js";
import { storedNote } from "../../test-utils/wallet.js";
import type { WalletContext } from "../context.js";
import type { StoredNote } from "../notes/note-store.js";
import { executeTransfer } from "../ops/transfer.js";
import { executeWithdraw } from "../ops/withdraw.js";

// Paying the relayer in an asset the spend is not otherwise moving.
//
// The circuit conserves value per asset, so the proof may carry both. These
// assert the fee note is in the chosen asset, its change is alongside, and each
// asset conserves independently. A wrong shape yields a witness that fails in
// circom or a fee note the relayer refuses with a 402.

const ASSET_A = 1n;
const ASSET_B = 2n;

async function makeCtx(notes: StoredNote[], est?: EstimateResponse) {
    const made = await makeTestCtx({
        notes,
        shape: TRANSACT_4X6,
        chain: {},
        ...(est ? { estimate: est } : {}),
    });
    const submitted = {
        get payload() {
            return made.submitted.at(-1) as SubmitTransactPayload | undefined;
        },
    };
    return { ...made, submitted };
}

/** Net value per asset in the witness: inputs minus outputs minus publicOut. */
function netByAsset(w: Record<string, unknown>): Map<bigint, bigint> {
    const net = new Map<bigint, bigint>();
    const bump = (a: bigint, v: bigint) => net.set(a, (net.get(a) ?? 0n) + v);
    const inAsset = w.in_asset as string[];
    const inValue = w.in_value as string[];
    const isDummy = w.in_is_dummy as string[];
    for (const [i, a] of inAsset.entries()) {
        if (isDummy[i] === "1") continue;
        bump(BigInt(a), BigInt(inValue[i]!));
    }
    for (const [j, a] of (w.out_asset as string[]).entries()) {
        bump(BigInt(a), -BigInt((w.out_value as string[])[j]!));
    }
    bump(BigInt(w.public_asset_id as string), -BigInt(w.public_out as string));
    return net;
}

/**
 * The slot a party's note landed in, and its plaintext, by trial decryption.
 *
 * Mirrors how a relayer finds its payment: every slot is tried, and one that
 * fails to decrypt belongs to another key. Asserts exactly one match.
 */
function noteFor(payload: SubmitTransactPayload, J: WalletContext["J"], ivk: bigint) {
    const hits = payload.aux.flatMap((a, slot) => {
        const plain = decryptNote({
            J,
            ivk,
            note: {
                epk: J.packPoint(a.ephPub),
                // The wire ciphertext carries a 2B clueBits prefix that the
                // ChaCha body does not include.
                ciphertext: stripClueBitsPrefix(a.ciphertext).body,
            },
        });
        return plain ? [{ slot, payload: decodeNotePayload(plain) }] : [];
    });
    expect(hits).toHaveLength(1);
    return hits[0]!;
}

describe("cross-asset relayer fee", () => {
    it("pays a transfer's fee from a second asset and conserves both", async () => {
        const notes = [
            storedNote("01", 100n, { asset: ASSET_A }),
            storedNote("02", 30n, { asset: ASSET_B }),
        ];
        const { ctx, witness, markedSpent } = await makeCtx(
            notes,
            estimateOf(await freshAddress(), { "2": 7n }),
        );
        const { address: recipient } = await makeCtx([]);

        const res = await executeTransfer(ctx, {
            recipient: recipient,
            amount: circuitAmount(30n),
            asset: ASSET_A,
            feeAsset: ASSET_B,
        });

        const w = witness.last!;
        // Asset B appears on both sides: the fee note out, its own note in.
        expect((w.out_asset as string[]).map(BigInt)).toContain(ASSET_B);
        // Every asset conserves independently, as the circuit requires. Keys are
        // asserted so the loop cannot pass vacuously over an empty map.
        const net = netByAsset(w);
        expect([...net.keys()].sort()).toEqual([ASSET_A, ASSET_B]);
        for (const [asset, v] of net) expect([asset, v]).toEqual([asset, 0n]);
        // Both notes are consumed, so neither is offered to a later spend.
        expect(markedSpent).toEqual([["01", "02"]]);
        // The fee came out of asset B, so asset A's change is the full remainder.
        expect(res.change).toBe(70n);
    });

    it("takes a same-asset fee out of change, not out of the recipient", async () => {
        const notes = [storedNote("01", 100n, { asset: ASSET_A })];
        const { ctx, witness } = await makeCtx(
            notes,
            estimateOf(await freshAddress(), { "1": 7n }),
        );
        const { address: recipient } = await makeCtx([]);

        const res = await executeTransfer(ctx, {
            recipient: recipient,
            amount: circuitAmount(30n),
            asset: ASSET_A,
        });

        const w = witness.last!;
        expect((w.out_value as string[]).map(BigInt)).toContain(30n); // recipient, unreduced
        const net = netByAsset(w);
        expect([...net.keys()]).toEqual([ASSET_A]);
        for (const [asset, v] of net) expect([asset, v]).toEqual([asset, 0n]);
        expect(res.change).toBe(63n); // 100 - 30 sent - 7 fee
    });

    it("builds no fee slot when the relayer is not charging", async () => {
        const notes = [storedNote("01", 100n, { asset: ASSET_A })];
        // Estimate present, but no shielded fee address: this chain subsidises.
        const est = { ...estimateOf(await freshAddress(), { "1": 7n }) };
        delete (est as { shieldedFeeAddress?: string }).shieldedFeeAddress;
        const { ctx, witness } = await makeCtx(notes, est);
        const { address: recipient } = await makeCtx([]);

        const res = await executeTransfer(ctx, {
            recipient: recipient,
            amount: circuitAmount(30n),
            asset: ASSET_A,
        });

        expect(res.change).toBe(70n);
        const outs = (witness.last!.out_asset as string[]).map(BigInt);
        expect(outs.every((a) => a === ASSET_A)).toBe(true);
    });

    /// Fails before proving instead of as a 402 after a full Groth16 run.
    it("refuses a fee asset the relayer does not quote", async () => {
        const notes = [
            storedNote("01", 100n, { asset: ASSET_A }),
            storedNote("02", 30n, { asset: ASSET_B }),
        ];
        const { ctx } = await makeCtx(notes, estimateOf(await freshAddress(), { "1": 7n }));
        const { address: recipient } = await makeCtx([]);

        await expect(
            executeTransfer(ctx, {
                recipient: recipient,
                amount: circuitAmount(30n),
                asset: ASSET_A,
                feeAsset: ASSET_B,
            }),
        ).rejects.toMatchObject({
            code: "FEE_ASSET_NOT_QUOTED",
            asset: 2n,
            kind: "transfer",
            accepted: [1n],
        });
    });

    it("pays a withdraw's fee from a second asset", async () => {
        const notes = [
            storedNote("01", 100n, { asset: ASSET_A }),
            storedNote("02", 30n, { asset: ASSET_B }),
        ];
        const { ctx, witness, markedSpent } = await makeCtx(
            notes,
            estimateOf(await freshAddress(), { "2": 7n }),
        );

        await executeWithdraw(ctx, {
            recipient: "0x00000000000000000000000000000000000000ff",
            gross: circuitAmount(40n),
            asset: ASSET_A,
            feeAsset: ASSET_B,
        });

        const w = witness.last!;
        // publicOut is charged to the transparent bucket's asset, never the fee's.
        expect(BigInt(w.public_asset_id as string)).toBe(ASSET_A);
        expect(BigInt(w.public_out as string)).toBe(40n);
        const net = netByAsset(w);
        expect([...net.keys()].sort()).toEqual([ASSET_A, ASSET_B]);
        for (const [asset, v] of net) expect([asset, v]).toEqual([asset, 0n]);
        expect(markedSpent).toEqual([["01", "02"]]);
    });

    /// The relayer must be able to find and read the note that pays it.
    ///
    /// A fee note carrying another slot's randomness still balances and proves
    /// but cannot be decrypted by the relayer.
    it("leaves the fee note readable by the relayer, and not counted as ours", async () => {
        const relayer = await identity();
        const notes = [
            storedNote("01", 100n, { asset: ASSET_A }),
            storedNote("02", 30n, { asset: ASSET_B }),
        ];
        const { ctx, submitted } = await makeCtx(notes, estimateOf(relayer.address, { "2": 7n }));
        const { address: recipient } = await makeCtx([]);

        const res = await executeTransfer(ctx, {
            recipient: recipient,
            amount: circuitAmount(30n),
            asset: ASSET_A,
            feeAsset: ASSET_B,
        });

        // Exactly one output decrypts to the relayer, and it is the fee.
        const paid = noteFor(submitted.payload!, ctx.J, relayer.ivk);
        expect(paid.payload?.asset).toBe(ASSET_B);
        expect(paid.payload?.value).toBe(7n);

        // The relayer's note is not booked as the wallet's income.
        expect(res.ownCommitments).not.toContain(res.commitments[paid.slot]);
    });
});

// Slot order is the only per-output signal that is not a commitment or a
// blinded point, so a fixed layout would reveal which commitment is the
// relayer's and which the payee's. These check that the wallet shuffles and that
// the receipt still names the payee's note.

describe("output slot order", () => {
    it("puts the fee at no fixed slot, and still names the payee's", async () => {
        const relayer = await identity();
        const payee = await identity();
        const feeSlots = new Set<number>();

        // 4x6 shape: six output slots. Draw until every slot has held the fee once — about 15
        // transfers on a fair shuffle — and give up at 80, where an unhit slot has probability at
        // most 6·(5/6)^80 < 3e-6. The cap must scale with the slot count to keep that bound.
        for (let i = 0; i < 80 && feeSlots.size < 6; i++) {
            const notes = [
                storedNote("01", 100n, { asset: ASSET_A }),
                storedNote("02", 30n, { asset: ASSET_B }),
            ];
            const { ctx, submitted } = await makeCtx(
                notes,
                estimateOf(relayer.address, { "2": 7n }),
            );
            const res = await executeTransfer(ctx, {
                recipient: payee.address,
                amount: circuitAmount(30n),
                asset: ASSET_A,
                feeAsset: ASSET_B,
            });

            feeSlots.add(noteFor(submitted.payload!, ctx.J, relayer.ivk).slot);
            // The receipt names the payee's note wherever it landed, and it is
            // not booked as the sender's income.
            const paid = noteFor(submitted.payload!, ctx.J, payee.ivk);
            expect(res.recipientCommitment).toBe(res.commitments[paid.slot]);
            expect(res.ownCommitments).not.toContain(res.recipientCommitment);
        }

        expect([...feeSlots].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it("refuses a zero-value transfer rather than padding the payee's slot", async () => {
        // Scanners discard zero-value outputs, so the receipt would have no
        // payee note to name.
        const { ctx } = await makeCtx([storedNote("01", 100n, { asset: ASSET_A })]);
        const { address: recipient } = await makeCtx([]);

        await expect(
            executeTransfer(ctx, {
                recipient: recipient,
                amount: circuitAmount(0n),
                asset: ASSET_A,
            }),
        ).rejects.toThrow(/amount must be positive/);
    });
});
