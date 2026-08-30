import { describe, expect, it, vi } from "vitest";
import { assetId, circuitAmount, evmAddress } from "../../core/brand.js";
import { NetworkError } from "../../core/errors.js";
import { randomJubjubScalar } from "../../core/random.js";
import { type CircuitShape, DEFAULT_SHAPE, shapeId, TRANSACT_SHAPES } from "../../core/shape.js";
import { WasmJubjub } from "../../crypto/jubjub-wasm/index.js";
import { Poseidon } from "../../crypto/poseidon.js";
import { addressFromSpendingKey, buildSpendingKey } from "../../keys/keys.js";
import type { Prover } from "../../prover/types.js";
import type { SpendContext } from "../context.js";
import type { StoredNote } from "../note-store.js";
import { executeTransfer } from "../transfer.js";
import { storedNote } from "../wallet-test-utils.js";
import { executeWithdraw } from "../withdraw.js";

// The executors depend on `SpendContext`, not on `Wallet`, so the fixture
// below is an object literal — no wasm, chain adapter, prover or note store.

/** Every published shape, tagged with the id that names its `describe` block. */
const SHAPES = TRANSACT_SHAPES.map((shape) => ({ id: shapeId(shape), shape }));

const RELAYER_ADDR = "0x0000000000000000000000000000000000000001";
const NATIVE_ADAPTER_ADDR = "0x00000000000000000000000000000000000ada9e";

async function makeCtx(notes: StoredNote[], shape: CircuitShape = DEFAULT_SHAPE) {
    const P = await Poseidon.build();
    const J = await WasmJubjub.build();
    const keys = buildSpendingKey(P, J, randomJubjubScalar());
    const address = addressFromSpendingKey(J, keys);

    const submitted: unknown[] = [];
    const markedSpent: string[][] = [];
    const reserved: string[][] = [];
    // Overridable so a test can make the submit fail with a chosen error.
    const submit = {
        impl: async (_payload: unknown): Promise<{ txHash: string }> => ({
            txHash: "0xdeadbeef",
        }),
    };

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
        // `prepareSpend` confirms the local root is one the chain holds before
        // spending anything; these tests are not about that check.
        verifyRoot: vi.fn(async () => true),
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
            relayerAddress: RELAYER_ADDR,
            feeBps: 0n,
            shape,
            chain: { nativeAdapterAddress: () => NATIVE_ADAPTER_ADDR },
        },
        prover,
        submitter: {
            async submit(payload: unknown) {
                submitted.push(payload);
                return submit.impl(payload);
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
        markPendingSpend: async (ids: string[]) => {
            reserved.push(ids);
        },
        autoConsolidate: async () => undefined,
        feeBps: async () => 0n,
        // Registry stand-in: these tests name assets by id, and `scale`/
        // `decimals` are what human amounts would resolve against.
        resolveAsset: async (ref: unknown) => ({
            id: BigInt(ref as bigint),
            token: "0x0000000000000000000000000000000000000000",
            scale: 1n,
            disabled: false,
            decimals: 18,
        }),
    } as unknown as SpendContext;

    return { ctx, prover, submitted, submit, markedSpent, reserved, treeStore, address };
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

    it("credits only the change slots when sending to someone else", async () => {
        const { ctx } = await makeCtx([storedNote("01", 100n)]);
        const { address: recipient } = await makeCtx([]);
        const res = await executeTransfer(ctx, { to: recipient, amount: circuitAmount(30n) });
        // Slot 0 is the recipient's; every other slot is change back to the sender.
        expect(res.commitments).toHaveLength(DEFAULT_SHAPE.nOut);
        expect(res.ownCommitments).toHaveLength(DEFAULT_SHAPE.nOut - 1);
    });

    it("credits every slot on a self-transfer", async () => {
        const { ctx, address } = await makeCtx([storedNote("01", 100n)]);
        const res = await executeTransfer(ctx, { to: address, amount: circuitAmount(30n) });
        expect(res.ownCommitments).toHaveLength(DEFAULT_SHAPE.nOut);
    });

    it("recognises a self-transfer written in uppercase bech32m", async () => {
        // Detection compares the decoded `pk`, not the address string.
        // bech32m permits an all-uppercase spelling of the same address, and a
        // string compare read it as "not self" — dropping slot 0 from
        // `ownIndices`, so `ownCommitments` and `ownInflow` under-reported a
        // note the caller does own.
        const { ctx, address } = await makeCtx([storedNote("01", 100n)]);

        const res = await executeTransfer(ctx, {
            to: address.toUpperCase(),
            amount: circuitAmount(30n),
        });

        expect(res.ownCommitments).toHaveLength(DEFAULT_SHAPE.nOut);
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
    it("splits change across every slot and tags the kind", async () => {
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
        // Every slot is change, so all belong to the sender.
        expect(res.commitments).toHaveLength(DEFAULT_SHAPE.nOut);
        expect(res.ownCommitments).toHaveLength(DEFAULT_SHAPE.nOut);
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

    /// `NativeAdapter` calls the pool itself, so it is the caller the pool
    /// checks (`pi.relayer == msg.sender`) and the address the WETH must land
    /// on before it can be unwrapped. The ETH then goes to `pi.payer`.
    it("binds a native withdraw to the adapter, not the relayer", async () => {
        const { ctx, submitted } = await makeCtx([storedNote("01", 100n)]);
        const to = evmAddress("0x0000000000000000000000000000000000000002");
        await executeWithdraw(
            ctx,
            { to, amount: circuitAmount(40n), asset: assetId(1n) },
            "withdrawNative",
        );

        const pi = (submitted[0] as { pubInputs: Record<string, string> }).pubInputs;
        expect(pi.relayer).toBe(NATIVE_ADAPTER_ADDR);
        expect(pi.recipient).toBe(NATIVE_ADAPTER_ADDR);
        expect(pi.payer).toBe(to);
    });

    /// The ERC-20 path is unchanged: the relayer submits and the pool pushes
    /// the token straight to the recipient.
    it("keeps an ERC-20 withdraw bound to the relayer", async () => {
        const { ctx, submitted } = await makeCtx([storedNote("01", 100n)]);
        const to = evmAddress("0x0000000000000000000000000000000000000002");
        await executeWithdraw(
            ctx,
            { to, amount: circuitAmount(40n), asset: assetId(1n) },
            "withdraw",
        );

        const pi = (submitted[0] as { pubInputs: Record<string, string> }).pubInputs;
        expect(pi.relayer).toBe(RELAYER_ADDR);
        expect(pi.recipient).toBe(to);
        expect(pi.payer).toBe(RELAYER_ADDR);
    });
});

// Arity is meant to be a parameter, not a shape of the code: nothing between
// the executors and the prover is written against a fixed slot count. So every
// published shape runs the same three assertions rather than each getting a
// hand-written copy — a new shape in `TRANSACT_SHAPES` is covered the day it
// lands, and an arity that leaked into supposedly shape-driven code fails at
// the shape it leaked for instead of going unnoticed.
//
// The recording prover stands in for the real one, so this needs no zkey.
describe.each(SHAPES)("shape $id", ({ shape }) => {
    const { nIn, nOut } = shape;

    // The fixture selector takes at most two notes, so two cover any arity;
    // the remaining input slots are dummies, which is itself the point.
    const FUNDED = [storedNote("01", 100n), storedNote("02", 200n)];

    const WITHDRAW_TO = evmAddress("0x0000000000000000000000000000000000000002");
    const withdrawArgs = {
        to: WITHDRAW_TO,
        amount: circuitAmount(40n),
        asset: assetId(1n),
    };

    it("fills every output slot, one for the recipient and the rest as change", async () => {
        const { ctx, submitted } = await makeCtx(FUNDED, shape);
        const { address: recipient } = await makeCtx([]);

        const res = await executeTransfer(ctx, {
            to: recipient,
            amount: circuitAmount(30n),
            selectOpts: { maxInputs: nIn },
        });

        expect(res.commitments).toHaveLength(nOut);
        // Slot 0 is the recipient's; the rest are change back to self.
        expect(res.ownCommitments).toHaveLength(nOut - 1);
        expect(res.change).toBe(res.inputSum - 30n);
        expect(res.ownInflow).toBe(res.change);

        // The payload the relayer receives carries one slot per arity.
        const pi = (submitted[0] as { pubInputs: Record<string, unknown[]> }).pubInputs;
        expect(pi.nullifier).toHaveLength(nIn);
        expect(pi.inCv).toHaveLength(nIn);
        expect(pi.outCm).toHaveLength(nOut);
        expect(pi.outCv).toHaveLength(nOut);
        expect(pi.outCvDep).toHaveLength(nOut);
        expect((submitted[0] as { aux: unknown[] }).aux).toHaveLength(nOut);
    });

    it("withdraws with every output slot as change", async () => {
        const { ctx, submitted } = await makeCtx([storedNote("01", 100n)], shape);
        const res = await executeWithdraw(ctx, withdrawArgs, "withdraw");

        // Nothing is shielded to a recipient, so every slot comes back to self.
        expect(res.commitments).toHaveLength(nOut);
        expect(res.ownCommitments).toHaveLength(nOut);
        expect(res.ownInflow).toBe(60n);
        expect((submitted[0] as { aux: unknown[] }).aux).toHaveLength(nOut);
    });

    it("pads unused input slots so a one-note spend still fills the arity", async () => {
        const { ctx, submitted } = await makeCtx([storedNote("01", 100n)], shape);
        await executeWithdraw(ctx, withdrawArgs, "withdraw");

        // Dummies pad the slots the single real note does not fill, and each
        // carries a distinct nullifier — a repeat would be a double-spend the
        // chain rejects.
        const pi = (submitted[0] as { pubInputs: { nullifier: unknown[] } }).pubInputs;
        expect(pi.nullifier).toHaveLength(nIn);
        expect(new Set(pi.nullifier.map(String)).size).toBe(nIn);
    });
});

// Which failures reserve notes is `outcomeUnknown`'s decision, and is tested
// against the errors themselves in `steps.test.ts`. What is left to pin here
// is that an executor routes its submit through that decision at all, rather
// than dropping the notes on the floor when a submit throws.
describe("a spend whose submit fails", () => {
    it("reserves its notes when the outcome is unknown", async () => {
        const { ctx, markedSpent, reserved, submit } = await makeCtx([storedNote("01", 100n)]);
        const { address: recipient } = await makeCtx([]);
        submit.impl = async () => {
            throw new NetworkError("RELAYER_FAILED", "/v1/spend", "HTTP 409", {
                status: 409,
                body: "nullifier in flight: chain 1",
            });
        };

        await expect(
            executeTransfer(ctx, { to: recipient, amount: circuitAmount(30n) }),
        ).rejects.toThrow(/409/);

        expect(reserved).toEqual([["01"]]);
        // Reserved, not spent: nothing here proves the notes are gone.
        expect(markedSpent).toEqual([]);
    });
});

describe("root verification before proving", () => {
    // The wallet trusts the server's `leafHash` rather than deriving leaves,
    // so a wrong one yields a wrong root with no local symptom. Proving
    // against it costs a full Groth16 run and then fails `isKnownRoot` as an
    // unexplained relayer rejection.

    it("proves against a root the chain confirms", async () => {
        const { ctx, treeStore, submitted } = await makeCtx([storedNote("01", 100n)]);
        const { address: recipient } = await makeCtx([]);

        await executeTransfer(ctx, { to: recipient, amount: circuitAmount(30n) });

        expect(treeStore.verifyRoot).toHaveBeenCalled();
        expect(submitted).toHaveLength(1);
    });

    it("resyncs once when the root disagrees, then proceeds", async () => {
        // Usually benign: the mirror lags the chain, so a tree synced
        // mid-block legitimately disagrees for a moment.
        const { ctx, treeStore, submitted } = await makeCtx([storedNote("01", 100n)]);
        const { address: recipient } = await makeCtx([]);
        treeStore.verifyRoot.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

        await executeTransfer(ctx, { to: recipient, amount: circuitAmount(30n) });

        expect(treeStore.sync).toHaveBeenCalledTimes(2);
        expect(submitted).toHaveLength(1);
    });

    it("refuses to prove when the root still disagrees after a resync", async () => {
        const { ctx, treeStore, submitted } = await makeCtx([storedNote("01", 100n)]);
        const { address: recipient } = await makeCtx([]);
        treeStore.verifyRoot.mockResolvedValue(false);

        await expect(
            executeTransfer(ctx, { to: recipient, amount: circuitAmount(30n) }),
        ).rejects.toThrow(/does not match the chain/);

        // The point of the check: nothing was proved and nothing was sent.
        expect(submitted).toHaveLength(0);
    });
});
