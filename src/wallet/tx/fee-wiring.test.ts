import { describe, expect, it, vi } from "vitest";
import { circuitAmount } from "../../core/brand.js";
import { randomJubjubScalar } from "../../core/random.js";
import { TRANSACT_4X6 } from "../../core/shape.js";
import { WasmJubjub } from "../../crypto/jubjub-wasm/index.js";
import { Poseidon } from "../../crypto/poseidon.js";
import { addressFromSpendingKey, buildSpendingKey } from "../../keys/keys.js";
import { decodeNotePayload, stripClueBitsPrefix } from "../../notes/codec.js";
import { decryptNote } from "../../notes/encrypt.js";
import type { EstimateResponse } from "../../protocol/responses.js";
import type { SubmitTransactPayload } from "../../protocol/transact.js";
import type { Prover } from "../../prover/types.js";
import type { SpendContext } from "../context.js";
import type { StoredNote } from "../note-store.js";
import { executeTransfer } from "../transfer.js";
import { storedNote } from "../wallet-test-utils.js";
import { executeWithdraw } from "../withdraw.js";

// Paying the relayer in an asset the spend is not otherwise moving.
//
// The circuit conserves value per asset, so the proof may carry both. These
// assert the wallet actually builds that shape — the fee note in the chosen
// asset, its change alongside, and every asset conserving on its own — because
// getting it wrong yields a witness that fails inside circom a minute later, or
// a fee note the relayer refuses with a 402.

const RELAYER_ADDR = "0x0000000000000000000000000000000000000001";
const ASSET_A = 1n;
const ASSET_B = 2n;

/**
 * A fresh shielded address, standing in for the relayer's own.
 *
 * The fee note is addressed to it, so it has to be a real bech32m address the
 * builder can decode — an EVM address here fails inside `feeOutput`.
 */
async function shieldedAddress(): Promise<string> {
    return (await relayerIdentity()).address;
}

/** A relayer: its shielded address, and the viewing key it collects with. */
async function relayerIdentity(): Promise<{ address: string; ivk: bigint }> {
    const P = await Poseidon.build();
    const J = await WasmJubjub.build();
    const keys = buildSpendingKey(P, J, randomJubjubScalar());
    return { address: addressFromSpendingKey(J, keys), ivk: keys.ivk };
}

/** A relayer charging `amounts` per asset, at its own shielded address. */
function estimate(feeAddress: string, amounts: Record<string, bigint>): EstimateResponse {
    return {
        gasUsed: 1,
        effectiveGasPriceWei: "1",
        totalNativeWei: "1",
        markupBps: 0,
        quotedAt: 0,
        shieldedFeeAddress: feeAddress,
        fees: Object.entries(amounts).map(([assetId, amount]) => ({
            tokenSymbol: `T${assetId}`,
            tokenAddress: "0x",
            decimals: 18,
            amount: amount.toString(),
            assetId: Number(assetId),
            circuitAmount: amount.toString(),
        })),
    };
}

async function makeCtx(notes: StoredNote[], est?: EstimateResponse) {
    const P = await Poseidon.build();
    const J = await WasmJubjub.build();
    const keys = buildSpendingKey(P, J, randomJubjubScalar());
    const address = addressFromSpendingKey(J, keys);

    const witness: { last?: Record<string, unknown> } = {};
    const prover: Prover = {
        async prove(input) {
            witness.last = input as Record<string, unknown>;
            return {
                proof: {
                    pi_a: ["1"],
                    pi_b: [["2"]],
                    pi_c: ["3"],
                    protocol: "groth16",
                    curve: "bn128",
                },
                publicSignals: [],
            };
        },
    };

    const markedSpent: string[][] = [];
    const submitted: { payload: SubmitTransactPayload | undefined } = { payload: undefined };
    const ctx = {
        P,
        J,
        keys,
        address,
        cfg: {
            chainId: 31337n,
            treeDepth: 4,
            relayerAddress: RELAYER_ADDR,
            feeBps: 0n,
            shape: TRANSACT_4X6,
            chain: {},
        },
        prover,
        submitter: {
            async submit(payload: unknown) {
                submitted.payload = payload as SubmitTransactPayload;
                return { txHash: "0xdeadbeef" };
            },
            ...(est ? { estimate: async () => est } : {}),
        },
        selector: {
            select(all: readonly StoredNote[], asset: bigint, target: bigint) {
                const picked = all.filter((n) => !n.spent && BigInt(n.asset) === asset).slice(0, 2);
                const sum = picked.reduce((a, n) => a + BigInt(n.value), 0n);
                if (sum < target) throw new Error("fixture: insufficient");
                return { plan: "direct" as const, notes: picked, sum };
            },
        },
        treeStore: {
            sync: vi.fn(async () => undefined),
            verifyRoot: vi.fn(async () => true),
            root: () => 0n,
            getPath: () => ({
                pathElements: Array.from({ length: 4 }, () => [0n, 0n, 0n]),
                pathIndices: [0, 0, 0, 0],
                root: 0n,
            }),
        },
        storedNotes: () => notes,
        markSpent: async (ids: string[]) => {
            markedSpent.push(ids);
        },
        markPendingSpend: async () => undefined,
        autoConsolidate: async () => undefined,
        // Registry stand-in: these tests name assets by id, and `scale`/
        // `decimals` are what human amounts would resolve against. Both fee
        // rates are zero: these cover slot wiring, not fee arithmetic.
        resolveAsset: async (ref: unknown) => ({
            id: BigInt(ref as bigint),
            token: "0x0000000000000000000000000000000000000000",
            scale: 1n,
            disabled: false,
            depositBps: 0n,
            withdrawBps: 0n,
            decimals: 18,
        }),
    } as unknown as SpendContext;

    return { ctx, witness, markedSpent, submitted, address };
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
 * Exactly what a relayer does to find its payment: every slot is tried, and one
 * that fails at any step is simply not ours. Asserts there is exactly one, since
 * every caller here builds a spend with a single note for the given key.
 */
function noteFor(payload: SubmitTransactPayload, J: SpendContext["J"], ivk: bigint) {
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
            estimate(await shieldedAddress(), { "2": 7n }),
        );
        const { address: recipient } = await makeCtx([]);

        const res = await executeTransfer(ctx, {
            to: recipient,
            amount: circuitAmount(30n),
            asset: ASSET_A,
            feeAsset: ASSET_B,
        });

        const w = witness.last!;
        // Asset B appears on both sides: the fee note out, its own note in.
        expect((w.out_asset as string[]).map(BigInt)).toContain(ASSET_B);
        // Every asset conserves independently — the circuit's actual rule.
        // Sizes asserted too: a loop over an empty map would assert nothing.
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
            estimate(await shieldedAddress(), { "1": 7n }),
        );
        const { address: recipient } = await makeCtx([]);

        const res = await executeTransfer(ctx, {
            to: recipient,
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
        const est = { ...estimate(await shieldedAddress(), { "1": 7n }) };
        delete (est as { shieldedFeeAddress?: string }).shieldedFeeAddress;
        const { ctx, witness } = await makeCtx(notes, est);
        const { address: recipient } = await makeCtx([]);

        const res = await executeTransfer(ctx, {
            to: recipient,
            amount: circuitAmount(30n),
            asset: ASSET_A,
        });

        expect(res.change).toBe(70n);
        const outs = (witness.last!.out_asset as string[]).map(BigInt);
        expect(outs.every((a) => a === ASSET_A)).toBe(true);
    });

    /// Better here than as a 402 after a full Groth16 run.
    it("refuses a fee asset the relayer does not quote", async () => {
        const notes = [
            storedNote("01", 100n, { asset: ASSET_A }),
            storedNote("02", 30n, { asset: ASSET_B }),
        ];
        const { ctx } = await makeCtx(notes, estimate(await shieldedAddress(), { "1": 7n }));
        const { address: recipient } = await makeCtx([]);

        await expect(
            executeTransfer(ctx, {
                to: recipient,
                amount: circuitAmount(30n),
                asset: ASSET_A,
                feeAsset: ASSET_B,
            }),
        ).rejects.toThrow(/quoted no payable amount for asset 2/);
    });

    it("pays a withdraw's fee from a second asset", async () => {
        const notes = [
            storedNote("01", 100n, { asset: ASSET_A }),
            storedNote("02", 30n, { asset: ASSET_B }),
        ];
        const { ctx, witness, markedSpent } = await makeCtx(
            notes,
            estimate(await shieldedAddress(), { "2": 7n }),
        );

        await executeWithdraw(
            ctx,
            {
                to: "0x00000000000000000000000000000000000000ff",
                amount: circuitAmount(40n),
                asset: ASSET_A,
                feeAsset: ASSET_B,
            },
            "withdraw",
        );

        const w = witness.last!;
        // publicOut is charged to the transparent bucket's asset, never the fee's.
        expect(BigInt(w.public_asset_id as string)).toBe(ASSET_A);
        expect(BigInt(w.public_out as string)).toBe(40n);
        const net = netByAsset(w);
        expect([...net.keys()].sort()).toEqual([ASSET_A, ASSET_B]);
        for (const [asset, v] of net) expect([asset, v]).toEqual([asset, 0n]);
        expect(markedSpent).toEqual([["01", "02"]]);
    });

    /// The acceptance test for the whole feature: the relayer must be able to
    /// find and read the note that pays it.
    ///
    /// This is what the positional arrays get wrong when they drift — a fee
    /// note carrying another slot's randomness still balances, still proves,
    /// and is still undecryptable by the only party that needed to read it.
    it("leaves the fee note readable by the relayer, and not counted as ours", async () => {
        const relayer = await relayerIdentity();
        const notes = [
            storedNote("01", 100n, { asset: ASSET_A }),
            storedNote("02", 30n, { asset: ASSET_B }),
        ];
        const { ctx, submitted } = await makeCtx(notes, estimate(relayer.address, { "2": 7n }));
        const { address: recipient } = await makeCtx([]);

        const res = await executeTransfer(ctx, {
            to: recipient,
            amount: circuitAmount(30n),
            asset: ASSET_A,
            feeAsset: ASSET_B,
        });

        // Exactly one output decrypts to the relayer, and it is the fee.
        const paid = noteFor(submitted.payload!, ctx.J, relayer.ivk);
        expect(paid.payload?.asset).toBe(ASSET_B);
        expect(paid.payload?.value).toBe(7n);

        // And the wallet must not book the relayer's note as income.
        expect(res.ownCommitments).not.toContain(res.commitments[paid.slot]);
    });
});

// Slot order is the only thing left in the output vector that separates one
// output from another — everything else is a commitment or a blinded point — so
// a fixed layout would publish which commitment is the relayer's and which is
// the payee's on every spend. This pins that the wallet shuffles, and that the
// receipt still names the payee's note without an index to read it off.

describe("output slot order", () => {
    it("puts the fee at no fixed slot, and still names the payee's", async () => {
        const relayer = await relayerIdentity();
        const payee = await relayerIdentity();
        const feeSlots = new Set<number>();

        // 4x6 shape: six output slots. A fixed layout returns one slot every
        // time; at 80 draws a fair shuffle leaves some slot unhit with
        // probability at most 6·(5/6)^80 < 3e-6. The draw count is tied to the
        // slot count — six slots need roughly twice the draws four did to keep
        // the flake rate here.
        for (let i = 0; i < 80; i++) {
            const notes = [
                storedNote("01", 100n, { asset: ASSET_A }),
                storedNote("02", 30n, { asset: ASSET_B }),
            ];
            const { ctx, submitted } = await makeCtx(notes, estimate(relayer.address, { "2": 7n }));
            const res = await executeTransfer(ctx, {
                to: payee.address,
                amount: circuitAmount(30n),
                asset: ASSET_A,
                feeAsset: ASSET_B,
            });

            feeSlots.add(noteFor(submitted.payload!, ctx.J, relayer.ivk).slot);
            // Wherever the payee's note landed, the receipt names it, and an
            // outgoing transfer is never booked as the sender's income.
            const paid = noteFor(submitted.payload!, ctx.J, payee.ivk);
            expect(res.recipientCommitment).toBe(res.commitments[paid.slot]);
            expect(res.ownCommitments).not.toContain(res.recipientCommitment);
        }

        expect([...feeSlots].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it("refuses a zero-value transfer rather than padding the payee's slot", async () => {
        // A zero-value output is a self-pad every scanner discards, so there
        // would be no payee note for the receipt to name.
        const { ctx } = await makeCtx([storedNote("01", 100n, { asset: ASSET_A })]);
        const { address: recipient } = await makeCtx([]);

        await expect(
            executeTransfer(ctx, {
                to: recipient,
                amount: circuitAmount(0n),
                asset: ASSET_A,
            }),
        ).rejects.toThrow(/amount must be positive/);
    });
});
