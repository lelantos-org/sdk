import { describe, expect, it, vi } from "vitest";
import type { ChainReader } from "../../chain/port.js";
import { assetId, circuitAmount, evmAddress } from "../../core/brand.js";
import { NetworkError } from "../../errors/network.js";
import {
    type CircuitShape,
    DEFAULT_SHAPE,
    shapeId,
    TRANSACT_SHAPES,
} from "../../protocol/shape.js";
import { makeTestCtx, NATIVE_ADAPTER_ADDR, TEST_RELAYER_ADDR } from "../../test-utils/context.js";
import { storedNote, unreconciled } from "../../test-utils/wallet.js";
import type { StoredNote } from "../notes/note-store.js";
import { executeTransfer } from "../ops/transfer.js";
import { executeWithdraw } from "../ops/withdraw.js";

// The executors depend on `WalletContext`, not on `Wallet`, so the fixture
// is a context over stubs: no chain adapter, prover or note store.

/** Every published shape, tagged with the id that names its `describe` block. */
const SHAPES = TRANSACT_SHAPES.map((shape) => ({ id: shapeId(shape), shape }));

const RELAYER_ADDR = TEST_RELAYER_ADDR;
const A1 = assetId(1n);

/**
 * The smallest chain layer that satisfies `ChainReader`.
 *
 * Typed rather than cast, since it is the subject of "spends against a chain
 * layer that cannot sign".
 */
const BARE_READER: ChainReader = {
    chainId: async () => 31337n,
    maspAddress: async () => evmAddress("0x0000000000000000000000000000000000000002"),
    fetchAsset: async () => {
        throw new Error("fixture: the spend path resolves assets through the registry");
    },
};

/** Every test's context: the notes it may spend, at `shape`, over `chain`. */
const makeCtx = (notes: StoredNote[], shape: CircuitShape = DEFAULT_SHAPE, chain?: unknown) =>
    makeTestCtx({ notes, shape, ...(chain !== undefined ? { chain } : {}) });

describe("executeTransfer", () => {
    it("submits, marks inputs spent, and reports change", async () => {
        const notes = [storedNote("01", 100n)];
        const { ctx, submitted, markedSpent, treeStore } = await makeCtx(notes);
        const { address: recipient } = await makeCtx([]);

        const res = await executeTransfer(ctx, {
            asset: A1,
            recipient,
            amount: circuitAmount(30n),
        });

        expect(submitted).toHaveLength(1);
        expect(markedSpent).toEqual([["01"]]);
        expect(res.amount).toMatchObject({ asset: 1n, amount: 30n, baseUnits: 30n });
        expect(res.change).toBe(70n);
        expect(treeStore.syncVerified).toHaveBeenCalledOnce();
    });

    it("spends against a chain layer that cannot sign", async () => {
        // A transfer proves ownership in the circuit and the relayer broadcasts
        // it and pays gas, so the signing half of the port is never reached and
        // a wallet without an EVM key (e.g. a passkey) can transfer. Deposit
        // requires signing; `capability.test.ts` enforces that at the type level.
        const notes = [storedNote("01", 100n)];
        const { ctx, submitted, markedSpent } = await makeCtx(notes, DEFAULT_SHAPE, BARE_READER);
        const { address: recipient } = await makeCtx([]);

        const res = await executeTransfer(ctx, {
            asset: A1,
            recipient,
            amount: circuitAmount(30n),
        });

        expect(submitted).toHaveLength(1);
        expect(markedSpent).toEqual([["01"]]);
        expect(res.amount).toMatchObject({ asset: 1n, amount: 30n, baseUnits: 30n });
    });

    it("credits only the change slots when sending to someone else", async () => {
        const { ctx } = await makeCtx([storedNote("01", 100n)]);
        const { address: recipient } = await makeCtx([]);
        const res = await executeTransfer(ctx, {
            asset: A1,
            recipient,
            amount: circuitAmount(30n),
        });
        // One slot is the recipient's; every other slot is change to the sender.
        expect(res.commitments).toHaveLength(DEFAULT_SHAPE.nOut);
        expect(res.ownCommitments).toHaveLength(DEFAULT_SHAPE.nOut - 1);
    });

    it("credits every slot on a self-transfer", async () => {
        const { ctx, address } = await makeCtx([storedNote("01", 100n)]);
        const res = await executeTransfer(ctx, {
            asset: A1,
            recipient: address,
            amount: circuitAmount(30n),
        });
        expect(res.ownCommitments).toHaveLength(DEFAULT_SHAPE.nOut);
    });

    it("recognises a self-transfer written in uppercase bech32m", async () => {
        // Detection compares the decoded `pk`, not the address string: bech32m
        // permits an all-uppercase spelling, which a string compare would treat
        // as another recipient and under-report `ownCommitments` and `ownInflow`.
        const { ctx, address } = await makeCtx([storedNote("01", 100n)]);

        const res = await executeTransfer(ctx, {
            asset: A1,
            recipient: address.toUpperCase(),
            amount: circuitAmount(30n),
        });

        expect(res.ownCommitments).toHaveLength(DEFAULT_SHAPE.nOut);
    });
});

describe("executeWithdraw", () => {
    it("splits change across every slot and tags the kind", async () => {
        const { ctx, submitted, markedSpent } = await makeCtx([storedNote("01", 100n)]);

        const res = await executeWithdraw(ctx, {
            recipient: evmAddress("0x0000000000000000000000000000000000000002"),
            gross: circuitAmount(40n),
            asset: assetId(1n),
        });

        expect((submitted[0] as { kind: string }).kind).toBe("withdraw");
        expect(markedSpent).toEqual([["01"]]);
        expect(res.gross).toMatchObject({ asset: 1n, amount: 40n });
        expect(res.change).toBe(60n);
        // Every slot is change, so all belong to the sender.
        expect(res.commitments).toHaveLength(DEFAULT_SHAPE.nOut);
        expect(res.ownCommitments).toHaveLength(DEFAULT_SHAPE.nOut);
    });

    it("routes withdrawNative to the native entry point", async () => {
        const { ctx, submitted } = await makeCtx([storedNote("01", 100n)]);
        await executeWithdraw(ctx, {
            recipient: evmAddress("0x0000000000000000000000000000000000000002"),
            gross: circuitAmount(40n),
            asset: assetId(1n),
            native: true,
        });
        expect((submitted[0] as { kind: string }).kind).toBe("withdrawNative");
    });

    /// `NativeAdapter` calls the pool itself, so it is the caller the pool
    /// checks (`pi.relayer == msg.sender`) and the address the WETH must land
    /// on before it can be unwrapped. The ETH then goes to `pi.payer`.
    it("binds a native withdraw to the adapter, not the relayer", async () => {
        const { ctx, submitted } = await makeCtx([storedNote("01", 100n)]);
        const to = evmAddress("0x0000000000000000000000000000000000000002");
        await executeWithdraw(ctx, {
            recipient: to,
            gross: circuitAmount(40n),
            asset: assetId(1n),
            native: true,
        });

        const pi = (submitted[0] as { pubInputs: Record<string, string> }).pubInputs;
        expect(pi.relayer).toBe(NATIVE_ADAPTER_ADDR);
        expect(pi.recipient).toBe(NATIVE_ADAPTER_ADDR);
        expect(pi.payer).toBe(to);
    });

    /// On the ERC-20 path the relayer submits and the pool sends the token
    /// directly to the recipient.
    it("keeps an ERC-20 withdraw bound to the relayer", async () => {
        const { ctx, submitted } = await makeCtx([storedNote("01", 100n)]);
        const to = evmAddress("0x0000000000000000000000000000000000000002");
        await executeWithdraw(ctx, {
            recipient: to,
            gross: circuitAmount(40n),
            asset: assetId(1n),
        });

        const pi = (submitted[0] as { pubInputs: Record<string, string> }).pubInputs;
        expect(pi.relayer).toBe(RELAYER_ADDR);
        expect(pi.recipient).toBe(to);
        expect(pi.payer).toBe(RELAYER_ADDR);
    });
});

// Nothing between the executors and the prover depends on a fixed slot count,
// so every shape in `TRANSACT_SHAPES` runs the same assertions. A hardcoded
// arity fails at the shape it does not match.
//
// The recording prover stands in for the real one, so no zkey is needed.
describe.each(SHAPES)("shape $id", ({ shape }) => {
    const { nIn, nOut } = shape;

    // The fixture selector takes at most two notes; the remaining input slots
    // are dummies, which exercises padding.
    const FUNDED = [storedNote("01", 100n), storedNote("02", 200n)];

    const WITHDRAW_TO = evmAddress("0x0000000000000000000000000000000000000002");
    const withdrawArgs = {
        recipient: WITHDRAW_TO,
        gross: circuitAmount(40n),
        asset: assetId(1n),
    };

    it("fills every output slot, one for the recipient and the rest as change", async () => {
        const { ctx, submitted } = await makeCtx(FUNDED, shape);
        const { address: recipient } = await makeCtx([]);

        const res = await executeTransfer(ctx, {
            asset: A1,
            recipient,
            amount: circuitAmount(30n),
            selection: { maxInputs: nIn },
        });

        expect(res.commitments).toHaveLength(nOut);
        // One slot is the recipient's; the rest are change to self.
        expect(res.ownCommitments).toHaveLength(nOut - 1);
        expect(res.change).toBe(300n - 30n);

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
        const res = await executeWithdraw(ctx, withdrawArgs);

        // Nothing is shielded to a recipient, so every slot comes back to self.
        expect(res.commitments).toHaveLength(nOut);
        expect(res.ownCommitments).toHaveLength(nOut);
        expect(res.change).toBe(60n);
        expect((submitted[0] as { aux: unknown[] }).aux).toHaveLength(nOut);
    });

    it("pads unused input slots so a one-note spend still fills the arity", async () => {
        const { ctx, submitted } = await makeCtx([storedNote("01", 100n)], shape);
        await executeWithdraw(ctx, withdrawArgs);

        // Each dummy carries a distinct nullifier; a repeat would be a
        // double-spend the chain rejects.
        const pi = (submitted[0] as { pubInputs: { nullifier: unknown[] } }).pubInputs;
        expect(pi.nullifier).toHaveLength(nIn);
        expect(new Set(pi.nullifier.map(String)).size).toBe(nIn);
    });
});

// Which failures reserve notes is decided by `outcomeUnknown` and tested in
// `steps.test.ts`. This checks that an executor routes a failed submit through
// that decision.
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
            executeTransfer(ctx, { asset: A1, recipient, amount: circuitAmount(30n) }),
        ).rejects.toMatchObject({ code: "RELAYER_REJECTED", reason: "nullifier-in-flight" });

        expect(reserved).toEqual([["01"]]);
        // Reserved, not spent: the failure does not prove the notes are gone.
        expect(markedSpent).toEqual([]);
    });
});

// A spend selects its notes long before the relayer answers. Two spends in one
// wallet must not both pick the same notes in between; see `leases.ts`.
describe("concurrent spends in one wallet", () => {
    const leased = (notes: StoredNote[]) => makeCtx(notes);
    const to = evmAddress("0x0000000000000000000000000000000000000002");

    it("select disjoint notes", async () => {
        const notes = ["01", "02", "03", "04", "05", "06"].map((id) => storedNote(id, 100n));
        const { ctx, markedSpent, leases } = await leased(notes);
        const { address: recipient } = await makeCtx([]);

        await Promise.all([
            executeTransfer(ctx, { asset: A1, recipient, amount: circuitAmount(150n) }),
            executeWithdraw(ctx, { recipient: to, gross: circuitAmount(150n), asset: assetId(1n) }),
            executeTransfer(ctx, { asset: A1, recipient, amount: circuitAmount(150n) }),
        ]);

        const spent = markedSpent.flat();
        expect(spent).toHaveLength(6);
        expect(new Set(spent).size).toBe(6);
        // Settled: nothing stays held once every spend is done.
        expect(leases.size).toBe(0);
    });

    it("return a refused spend's notes to selection", async () => {
        const { ctx, submit, markedSpent, reserved, leases } = await leased([
            storedNote("01", 100n),
        ]);
        const { address: recipient } = await makeCtx([]);
        submit.impl = async () => {
            throw new NetworkError("RELAYER_FAILED", "/v1/spend", "HTTP 400", { status: 400 });
        };

        await expect(
            executeTransfer(ctx, { asset: A1, recipient, amount: circuitAmount(30n) }),
        ).rejects.toMatchObject({ code: "RELAYER_REJECTED", status: 400 });
        expect(leases.size).toBe(0);
        expect(reserved).toEqual([]);

        // The same note is selectable again.
        submit.impl = async () => ({ txHash: "0xdeadbeef" });
        await executeTransfer(ctx, { asset: A1, recipient, amount: circuitAmount(30n) });
        expect(markedSpent).toEqual([["01"]]);
    });

    it("reserve an unknown outcome's notes before releasing the lease", async () => {
        const { ctx, submit, reserved, leases, noteCache } = await leased([storedNote("01", 100n)]);
        const { address: recipient } = await makeCtx([]);
        const heldWhenReserved: boolean[] = [];
        const markPendingSpend = noteCache.markPendingSpend;
        noteCache.markPendingSpend = async (ids) => {
            heldWhenReserved.push(leases.has("01"));
            await markPendingSpend(ids);
        };
        submit.impl = async () => {
            throw new NetworkError("RELAYER_TIMEOUT", "/v1/spend", "request timeout");
        };

        await expect(
            executeTransfer(ctx, { asset: A1, recipient, amount: circuitAmount(30n) }),
        ).rejects.toMatchObject({ code: "SPEND_OUTCOME_UNKNOWN", reservedNoteIds: ["01"] });

        expect(reserved).toEqual([["01"]]);
        // No window in which the note is neither leased nor reserved.
        expect(heldWhenReserved).toEqual([true]);
        expect(leases.size).toBe(0);
    });

    it("release the notes when proving fails", async () => {
        const { ctx, prover, leases } = await leased([storedNote("01", 100n)]);
        const { address: recipient } = await makeCtx([]);
        prover.prove = async () => {
            throw new Error("prover died");
        };

        await expect(
            executeTransfer(ctx, { asset: A1, recipient, amount: circuitAmount(30n) }),
        ).rejects.toThrow("prover died");
        expect(leases.size).toBe(0);
    });

    it("release the notes when the tree cannot be reconciled", async () => {
        const { ctx, treeStore, leases } = await leased([storedNote("01", 100n)]);
        const { address: recipient } = await makeCtx([]);
        treeStore.syncVerified.mockResolvedValue(unreconciled());

        await expect(
            executeTransfer(ctx, { asset: A1, recipient, amount: circuitAmount(30n) }),
        ).rejects.toThrow(/does not match the chain/);
        expect(leases.size).toBe(0);
    });
});

describe("root verification before proving", () => {
    // The wallet trusts the server's `leafHash` rather than deriving leaves,
    // so a wrong one yields a wrong root with no local symptom. Proving
    // against it costs a full Groth16 run and then fails `isKnownRoot`.
    //
    // Tree repair is covered in `tree-store.test.ts`; the spend path only
    // refuses to prove against an unreconciled tree.

    it("proves against a root the chain confirms", async () => {
        const { ctx, treeStore, submitted } = await makeCtx([storedNote("01", 100n)]);
        const { address: recipient } = await makeCtx([]);

        await executeTransfer(ctx, { asset: A1, recipient, amount: circuitAmount(30n) });

        expect(treeStore.syncVerified).toHaveBeenCalled();
        expect(submitted).toHaveLength(1);
    });

    it("refuses to prove when the tree cannot be reconciled", async () => {
        const { ctx, treeStore, submitted } = await makeCtx([storedNote("01", 100n)]);
        const { address: recipient } = await makeCtx([]);
        treeStore.syncVerified.mockResolvedValue(unreconciled());

        await expect(
            executeTransfer(ctx, { asset: A1, recipient, amount: circuitAmount(30n) }),
        ).rejects.toMatchObject({
            code: "TREE_OUT_OF_SYNC",
            retryable: true,
            localRoot: "0",
            mirrorRoot: "1",
        });

        // Nothing was proved or sent.
        expect(submitted).toHaveLength(0);
    });

    it("hands the adapter's root oracle to the tree store", async () => {
        // `syncVerified` decides whether to consult the pool; the spend path
        // only supplies the capability. No other test covers this wiring.
        const { ctx, treeStore } = await makeCtx([storedNote("01", 100n)]);
        const { address: recipient } = await makeCtx([]);
        const isKnownRoot = vi.fn(async () => true);
        ctx.cfg.chain.isKnownRoot = isKnownRoot;

        await executeTransfer(ctx, { asset: A1, recipient, amount: circuitAmount(30n) });

        expect(treeStore.syncVerified).toHaveBeenCalledWith(
            expect.objectContaining({ isKnownRoot: expect.any(Function) }),
        );
    });
});
