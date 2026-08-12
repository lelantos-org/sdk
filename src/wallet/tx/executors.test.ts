import { describe, expect, it, vi } from "vitest";
import { assetId, circuitAmount, evmAddress } from "../../core/brand.js";
import { randomFr, randomJubjubScalar } from "../../core/random.js";
import { type CircuitShape, TRANSACT_2X2, TRANSACT_3X3 } from "../../core/shape.js";
import { WasmJubjub } from "../../crypto/jubjub-wasm/index.js";
import { Poseidon } from "../../crypto/poseidon.js";
import { addressFromSpendingKey, buildSpendingKey } from "../../keys/keys.js";
import type { Prover } from "../../prover/types.js";
import type { SpendContext } from "../context.js";
import type { StoredNote } from "../note-store.js";
import { executeTransfer } from "../transfer.js";
import { executeWithdraw } from "../withdraw.js";

// The executors depend on `SpendContext`, not on `Wallet`, so the fixture
// below is an object literal — no wasm, chain adapter, prover or note store.

function storedNote(id: string, value: bigint, asset = 1n): StoredNote {
    return {
        id,
        asset: asset.toString(),
        value: value.toString(),
        rho: randomFr().toString(),
        rcm: randomFr().toString(),
        rcvDep: randomJubjubScalar().toString(),
        cm: `0x${id.padStart(64, "0")}`,
        leafIndex: Number.parseInt(id, 16) || 0,
        spent: false,
        discoveredAt: "1970-01-01T00:00:00Z",
    };
}

async function makeCtx(notes: StoredNote[], shape: CircuitShape = TRANSACT_2X2) {
    const P = await Poseidon.build();
    const J = await WasmJubjub.build();
    const keys = buildSpendingKey(P, J, randomJubjubScalar());
    const address = addressFromSpendingKey(J, keys);

    const submitted: unknown[] = [];
    const markedSpent: string[][] = [];

    const prover: Prover = {
        async prove() {
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

    const treeStore = {
        sync: vi.fn(async () => undefined),
        root: () => 0n,
        getPath: () => ({
            pathElements: Array.from({ length: 4 }, () => [0n, 0n, 0n]),
            pathIndices: [0, 0, 0, 0],
            root: 0n,
        }),
    };

    const ctx = {
        P,
        J,
        keys,
        address,
        cfg: {
            chainId: 31337n,
            treeDepth: 4,
            relayerAddress: "0x0000000000000000000000000000000000000001",
            feeBps: 0n,
            shape,
        },
        prover,
        submitter: {
            async submit(payload: unknown) {
                submitted.push(payload);
                return { txHash: "0xdeadbeef" };
            },
        },
        selector: {
            select(all: readonly StoredNote[], asset: bigint, target: bigint) {
                const picked = all.filter((n) => !n.spent && BigInt(n.asset) === asset).slice(0, 2);
                const sum = picked.reduce((a, n) => a + BigInt(n.value), 0n);
                if (sum < target) throw new Error("fixture: insufficient");
                return { plan: "direct" as const, notes: picked, sum };
            },
        },
        treeStore,
        storedNotes: () => notes,
        markSpent: async (ids: string[]) => {
            markedSpent.push(ids);
        },
        autoConsolidate: async () => undefined,
        feeBps: async () => 0n,
    } as unknown as SpendContext;

    return { ctx, prover, submitted, markedSpent, treeStore, address };
}

describe("executeTransfer", () => {
    it("submits, marks inputs spent, and reports change", async () => {
        const notes = [storedNote("01", 100n)];
        const { ctx, submitted, markedSpent, treeStore } = await makeCtx(notes);
        const { address: recipient } = await makeCtx([]);

        const res = await executeTransfer(ctx, { to: recipient, amount: circuitAmount(30n) });

        expect(submitted).toHaveLength(1);
        expect(markedSpent).toEqual([["01"]]);
        expect(res.sent).toBe(30n);
        expect(res.change).toBe(70n);
        expect(treeStore.sync).toHaveBeenCalledOnce();
    });

    it("credits only the change slot when sending to someone else", async () => {
        const { ctx } = await makeCtx([storedNote("01", 100n)]);
        const { address: recipient } = await makeCtx([]);
        const res = await executeTransfer(ctx, { to: recipient, amount: circuitAmount(30n) });
        // Output 0 is the recipient's; only output 1 (change) is ours.
        expect(res.ownCommitments).toHaveLength(1);
    });

    it("credits both slots on a self-transfer", async () => {
        const { ctx, address } = await makeCtx([storedNote("01", 100n)]);
        const res = await executeTransfer(ctx, { to: address, amount: circuitAmount(30n) });
        expect(res.ownCommitments).toHaveLength(2);
    });

    it("reports the phases in order", async () => {
        const { ctx } = await makeCtx([storedNote("01", 100n)]);
        const { address: recipient } = await makeCtx([]);
        const phases: string[] = [];
        await executeTransfer(ctx, {
            to: recipient,
            amount: circuitAmount(10n),
            onPhase: (p) => phases.push(p),
        });
        expect(phases).toEqual(["preparing", "proving", "submitting"]);
    });

    it("does not let a throwing onPhase break the transaction", async () => {
        const { ctx } = await makeCtx([storedNote("01", 100n)]);
        const { address: recipient } = await makeCtx([]);
        const res = await executeTransfer(ctx, {
            to: recipient,
            amount: circuitAmount(10n),
            onPhase: () => {
                throw new Error("listener blew up");
            },
        });
        expect(res.txHash).toBe("0xdeadbeef");
    });
});

describe("executeWithdraw", () => {
    it("splits change across both slots and tags the kind", async () => {
        const { ctx, submitted, markedSpent } = await makeCtx([storedNote("01", 100n)]);

        const res = await executeWithdraw(
            ctx,
            {
                to: evmAddress("0x0000000000000000000000000000000000000002"),
                amount: circuitAmount(40n),
                asset: assetId(1n),
            },
            "withdraw",
        );

        expect((submitted[0] as { kind: string }).kind).toBe("withdraw");
        expect(markedSpent).toEqual([["01"]]);
        expect(res.sent).toBe(40n);
        expect(res.change).toBe(60n);
        // Both change slots are ours.
        expect(res.ownCommitments).toHaveLength(2);
        expect(res.ownInflow).toBe(60n);
    });

    it("routes withdrawNative to the native entry point", async () => {
        const { ctx, submitted } = await makeCtx([storedNote("01", 100n)]);
        await executeWithdraw(
            ctx,
            {
                to: evmAddress("0x0000000000000000000000000000000000000002"),
                amount: circuitAmount(40n),
                asset: assetId(1n),
            },
            "withdrawNative",
        );
        expect((submitted[0] as { kind: string }).kind).toBe("withdrawNative");
    });
});

// The 3×3 shape has no proving key yet, but everything up to the prover is
// shape-driven and the recording prover stands in for it. These assert the
// generalisation actually holds: three input slots, three outputs, change
// split across the slots the recipient does not take, and a balanced witness.
describe("shape 3x3", () => {
    it("transfers with three inputs and splits change over the two spare slots", async () => {
        const notes = [storedNote("01", 30n), storedNote("02", 40n), storedNote("03", 50n)];
        const { ctx, submitted } = await makeCtx(notes, TRANSACT_3X3);
        const { address: recipient } = await makeCtx([]);

        const res = await executeTransfer(ctx, {
            to: recipient,
            amount: circuitAmount(60n),
            selectOpts: { maxInputs: 3 },
        });

        expect(res.commitments).toHaveLength(3);
        // Slot 0 is the recipient's; slots 1 and 2 are change back to self.
        expect(res.ownCommitments).toHaveLength(2);
        expect(res.change).toBe(res.inputSum - 60n);
        expect(res.ownInflow).toBe(res.change);

        // The payload the relayer receives carries one slot per arity.
        const pi = (submitted[0] as { pubInputs: Record<string, unknown[]> }).pubInputs;
        expect(pi.nullifier).toHaveLength(3);
        expect(pi.outCm).toHaveLength(3);
        expect(pi.inCv).toHaveLength(3);
        expect(pi.outCv).toHaveLength(3);
        expect(pi.outCvDep).toHaveLength(3);
        expect((submitted[0] as { aux: unknown[] }).aux).toHaveLength(3);
    });

    it("withdraws with every output slot as change", async () => {
        const { ctx, submitted } = await makeCtx([storedNote("01", 100n)], TRANSACT_3X3);
        const res = await executeWithdraw(
            ctx,
            {
                to: evmAddress("0x0000000000000000000000000000000000000002"),
                amount: circuitAmount(40n),
                asset: assetId(1n),
            },
            "withdraw",
        );
        expect(res.commitments).toHaveLength(3);
        expect(res.ownCommitments).toHaveLength(3);
        expect(res.ownInflow).toBe(60n);
        expect((submitted[0] as { aux: unknown[] }).aux).toHaveLength(3);
    });

    it("pads unused input slots so a one-note spend still fills the arity", async () => {
        const { ctx, submitted } = await makeCtx([storedNote("01", 100n)], TRANSACT_3X3);
        await executeWithdraw(
            ctx,
            {
                to: evmAddress("0x0000000000000000000000000000000000000002"),
                amount: circuitAmount(40n),
                asset: assetId(1n),
            },
            "withdraw",
        );
        // Two dummies pad the slots the single real note does not fill.
        const pi = (submitted[0] as { pubInputs: { nullifier: unknown[] } }).pubInputs;
        expect(pi.nullifier).toHaveLength(3);
        expect(new Set(pi.nullifier.map(String)).size).toBe(3);
    });
});
