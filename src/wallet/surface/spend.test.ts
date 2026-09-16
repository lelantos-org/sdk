// The spend methods: phases and `opId`, the caller's signal
// and deadline, gross/net withdrawals, native withdrawals, relayer fees as `Money`, and
// `spendableMax`'s fee reservation. Driven through `spendMethods` over a stubbed context, so each
// runs the real operation envelope (`runOp`) and the real spend pipeline.

import { afterEach, describe, expect, it, vi } from "vitest";
import { assetId, circuitAmount, evmAddress } from "../../core/brand.js";
import { isWalletError } from "../../errors/guard.js";
import { NetworkError } from "../../errors/network.js";
import type { EstimateResponse } from "../../protocol/responses.js";
import { FAKE_PROOF, makeTestCtx, NATIVE_ADAPTER_ADDR } from "../../test-utils/context.js";
import { estimateOf, freshAddress } from "../../test-utils/estimate.js";
import { storedNote } from "../../test-utils/wallet.js";
import type { AssetInfo } from "../assets/info.js";
import type { StoredNote } from "../notes/note-store.js";
import type { SelectionResult } from "../selection/index.js";
import type { PhaseInfo } from "../types/options.js";
import type { WalletApiExtras } from "./api.js";
import { consolidateFor, spendMethods } from "./spend.js";
import { WalletStateStore } from "./state.js";

const A = assetId(1n);
const B = assetId(2n);
const TO = evmAddress(`0x${"bb".repeat(20)}`);

/** Asset 1: scale 1, 1% withdraw fee, ladder 100/200. Asset 2: scale 1000, no fees. */
const ASSETS: Record<string, Partial<AssetInfo>> = {
    "1": { id: A, scale: 1n, withdrawBps: 100n, depositBps: 0n, ladder: [100n, 200n] },
    "2": { id: B, scale: 1_000n, withdrawBps: 0n, depositBps: 0n, ladder: [] },
};

async function harness(
    opts: { notes?: StoredNote[]; estimate?: EstimateResponse; chain?: unknown } = {},
) {
    const made = await makeTestCtx({
        notes: opts.notes ?? [],
        ...(opts.estimate ? { estimate: opts.estimate } : {}),
        ...(opts.chain !== undefined ? { chain: opts.chain } : {}),
        resolveAsset: async (ref) => ({
            token: `0x${"aa".repeat(20)}`,
            disabled: false,
            decimals: 6,
            ...ASSETS[String(ref)],
        }),
    });
    const state = new WalletStateStore({ notes: [], onChange: () => undefined } as never);
    const awaitCommitments = vi.fn(async () => ({
        status: "seen" as const,
        missing: [],
        attempts: 1,
    }));
    const env = {
        ctx: made.ctx,
        extras: { state, prover: { available: true } } as unknown as WalletApiExtras,
        awaitCommitments,
    };
    return { ...made, state, awaitCommitments, wallet: spendMethods(env) };
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe("phases and opId", () => {
    it("emits preparing → proving → submitting → confirmed under one opId", async () => {
        const { wallet } = await harness({ notes: [storedNote("01", 100n)] });
        const seen: [string, PhaseInfo][] = [];
        const res = await wallet.transfer({
            asset: A,
            recipient: await freshAddress(),
            amount: circuitAmount(10n),
            opId: "order:7",
            onPhase: (phase, info) => seen.push([phase, info]),
        });
        expect(seen.map(([p]) => p)).toEqual(["preparing", "proving", "submitting", "confirmed"]);
        expect(seen.every(([, info]) => info.opId === "order:7")).toBe(true);
        expect(seen.at(-1)?.[1].txHash).toBe(res.txHash);
        expect(seen[0]?.[1].txHash).toBeUndefined();
        expect(res.opId).toBe("order:7");
        expect(Object.isFrozen(res)).toBe(true);
    });

    it("mints an opId when none is given, and survives a throwing onPhase", async () => {
        const { wallet } = await harness({ notes: [storedNote("01", 100n)] });
        const res = await wallet.transfer({
            asset: A,
            recipient: await freshAddress(),
            amount: circuitAmount(10n),
            onPhase: () => {
                throw new Error("listener blew up");
            },
        });
        expect(res.opId).toMatch(/^[0-9a-f]{16}$/);
    });

    it("stamps the opId on an error's context", async () => {
        const { wallet, submit } = await harness({ notes: [storedNote("01", 100n)] });
        submit.impl = async () => {
            throw new NetworkError("RELAYER_FAILED", "/v1/spend", "HTTP 400", { status: 400 });
        };
        const err = await wallet
            .withdraw({ asset: A, recipient: TO, gross: circuitAmount(50n), opId: "w-1" })
            .catch((e: unknown) => e);
        expect(isWalletError(err, "RELAYER_REJECTED")).toBe(true);
        expect(err).toMatchObject({ context: { opId: "w-1", op: "withdraw" } });
    });

    /** A selector that asks for a merge first, then covers from whatever the merge left. */
    function mergingSelector(notes: StoredNote[]) {
        let merged = false;
        return {
            select(
                all: readonly StoredNote[],
                asset: bigint,
                target: bigint,
                opts?: { only?: readonly string[] },
            ) {
                const pool = all.filter((n) => !n.spent && BigInt(n.asset) === asset);
                if (!merged && !opts?.only) {
                    merged = true;
                    return {
                        plan: "consolidate-first",
                        consolidate: pool,
                        consolidateSum: pool.reduce((a, n) => a + BigInt(n.value), 0n),
                    } as unknown as SelectionResult;
                }
                const picked = pool
                    .filter((n) => !opts?.only || opts.only.includes(n.id))
                    .slice(0, 2);
                const sum = picked.reduce((a, n) => a + BigInt(n.value), 0n);
                if (sum < target) throw new Error("fixture: insufficient");
                return { plan: "direct", notes: picked, sum } as unknown as SelectionResult;
            },
            notes,
        };
    }

    it("wraps auto-consolidation in `consolidating`, and hands the merge the parent's opId", async () => {
        const notes = [storedNote("01", 60n), storedNote("02", 60n)];
        const { wallet, ctx } = await harness({ notes });
        (ctx.cfg as { selector: unknown }).selector = mergingSelector(notes);
        const parents: unknown[] = [];
        (ctx as { autoConsolidate: unknown }).autoConsolidate = async (
            _a: unknown,
            _s: unknown,
            parent: unknown,
        ) => {
            parents.push(parent);
        };
        const phases: string[] = [];
        await wallet.transfer({
            asset: A,
            recipient: await freshAddress(),
            amount: circuitAmount(100n),
            autoConsolidate: true,
            opId: "c-1",
            onPhase: (p) => phases.push(p),
        });
        expect(phases).toEqual([
            "preparing",
            "consolidating",
            "preparing",
            "proving",
            "submitting",
            "confirmed",
        ]);
        expect(parents).toEqual([expect.objectContaining({ opId: "c-1", op: "transfer" })]);
    });

    it("reports a failed merge as `<op>:consolidate` under the parent's opId", async () => {
        const notes = [storedNote("01", 60n), storedNote("02", 60n)];
        const { wallet, ctx, submit, awaitCommitments } = await harness({ notes });
        (ctx.cfg as { selector: unknown }).selector = mergingSelector(notes);
        (ctx as { autoConsolidate: unknown }).autoConsolidate = (
            asset: bigint,
            sel: never,
            parent: never,
        ) => consolidateFor(ctx, awaitCommitments as never, asset as never, sel, parent);
        submit.impl = async () => {
            throw new NetworkError("RELAYER_FAILED", "/v1/spend", "HTTP 400", { status: 400 });
        };
        const phases: string[] = [];
        const err = await wallet
            .transfer({
                asset: A,
                recipient: await freshAddress(),
                amount: circuitAmount(100n),
                autoConsolidate: true,
                opId: "c-2",
                onPhase: (p) => phases.push(p),
            })
            .catch((e: unknown) => e);
        expect(err).toMatchObject({
            code: "RELAYER_REJECTED",
            context: { opId: "c-2", op: "transfer:consolidate" },
        });
        // The nested self-spend's own phases are not re-emitted.
        expect(phases).toEqual(["preparing", "consolidating"]);
    });
});

describe("signal and deadline", () => {
    it("rejects with the signal's reason between phases, releasing the lease, sending nothing", async () => {
        const { wallet, leases, submitted, markedSpent } = await harness({
            notes: [storedNote("01", 100n)],
        });
        const ctrl = new AbortController();
        const reason = new DOMException("user left", "AbortError");
        const err = await wallet
            .transfer({
                asset: A,
                recipient: await freshAddress(),
                amount: circuitAmount(10n),
                signal: ctrl.signal,
                onPhase: (p) => {
                    if (p === "proving") ctrl.abort(reason);
                },
            })
            .catch((e: unknown) => e);
        expect(err).toBe(reason);
        expect(leases.size).toBe(0);
        expect(submitted).toHaveLength(0);
        expect(markedSpent).toEqual([]);
    });

    it("refuses an already-aborted signal before any work", async () => {
        const { wallet, witness } = await harness({ notes: [storedNote("01", 100n)] });
        const ctrl = new AbortController();
        ctrl.abort("stop");
        await expect(
            wallet.withdraw({
                asset: A,
                recipient: TO,
                gross: circuitAmount(50n),
                signal: ctrl.signal,
            }),
        ).rejects.toBe("stop");
        expect(witness.last).toBeUndefined();
    });

    it("refuses to submit once the deadline passed during proving", async () => {
        const { wallet, prover, leases, submitted, reserved, markedSpent } = await harness({
            notes: [storedNote("01", 100n)],
        });
        const start = Date.now();
        const deadline = BigInt(Math.floor(start / 1000) + 60);
        prover.prove = async () => {
            // Proving took two minutes.
            vi.spyOn(Date, "now").mockReturnValue(start + 120_000);
            return FAKE_PROOF;
        };
        const err = await wallet
            .transfer({
                asset: A,
                recipient: await freshAddress(),
                amount: circuitAmount(10n),
                deadline,
            })
            .catch((e: unknown) => e);
        expect(isWalletError(err, "DEADLINE_PASSED")).toBe(true);
        expect(err).toMatchObject({ deadline });
        expect(submitted).toHaveLength(0);
        expect(leases.size).toBe(0);
        expect(reserved).toEqual([]);
        expect(markedSpent).toEqual([]);
    });

    it("refuses a past deadline before selecting", async () => {
        const { wallet, witness } = await harness({ notes: [storedNote("01", 100n)] });
        await expect(
            wallet.transfer({
                asset: A,
                recipient: await freshAddress(),
                amount: circuitAmount(10n),
                deadline: 1n,
            }),
        ).rejects.toMatchObject({ code: "DEADLINE_PASSED" });
        expect(witness.last).toBeUndefined();
    });
});

describe("withdraw", () => {
    it("grosses a net amount up to the smallest publicOut delivering it, off the ladder", async () => {
        const { wallet, witness } = await harness({ notes: [storedNote("01", 500n)] });
        const res = await wallet.withdraw({ asset: A, recipient: TO, net: { baseUnits: 150n } });
        // 151 − floor(1% of 151) = 150; 150 would deliver 149.
        expect(BigInt(witness.last!.public_out as string)).toBe(151n);
        expect(res.gross).toEqual({ asset: A, amount: 151n, baseUnits: 151n });
        expect(res.net).toEqual({ asset: A, amount: 150n, baseUnits: 150n });
        expect(res.fees.protocol).toEqual({ asset: A, amount: 1n, baseUnits: 1n });
        expect(res.onLadder).toBe(false);
        expect(res.recipient).toBe(TO);
    });

    it("reports a ladder gross as on the ladder", async () => {
        const { wallet } = await harness({ notes: [storedNote("01", 500n)] });
        const res = await wallet.withdraw({ asset: A, recipient: TO, gross: circuitAmount(200n) });
        expect(res.net).toEqual({ asset: A, amount: 198n, baseUnits: 198n });
        expect(res.onLadder).toBe(true);
        expect(res.fees.relayer).toBeNull();
    });

    it("unwraps natively and pays the relayer in another asset", async () => {
        const { wallet, submitted } = await harness({
            notes: [storedNote("01", 500n, { asset: A }), storedNote("02", 30n, { asset: B })],
            estimate: estimateOf(await freshAddress(), { "2": 7n }),
        });
        const res = await wallet.withdraw({
            asset: A,
            recipient: TO,
            gross: circuitAmount(100n),
            native: true,
            feeAsset: B,
        });
        const payload = submitted[0] as { kind: string; pubInputs: Record<string, string> };
        expect(payload.kind).toBe("withdrawNative");
        expect(payload.pubInputs.relayer).toBe(NATIVE_ADAPTER_ADDR);
        expect(payload.pubInputs.payer).toBe(TO);
        expect(res.native).toBe(true);
        // A fee note in asset 2: `amount` exact, `baseUnits` at scale 1000.
        expect(res.fees.relayer).toEqual({ asset: B, amount: 7n, baseUnits: 7_000n });
    });

    it("refuses a native withdrawal without an adapter before quoting or selecting", async () => {
        const estimate = vi.fn(async () => estimateOf(undefined));
        const { wallet, ctx, witness } = await harness({
            notes: [storedNote("01", 500n)],
            chain: {},
        });
        (ctx.cfg.submitter as { estimate: unknown }).estimate = estimate;
        await expect(
            wallet.withdraw({ asset: A, recipient: TO, gross: circuitAmount(100n), native: true }),
        ).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
        expect(estimate).not.toHaveBeenCalled();
        expect(witness.last).toBeUndefined();
    });
});

describe("relayer fee on the result", () => {
    it("is the fee note actually built, in the spend asset", async () => {
        const { wallet } = await harness({
            notes: [storedNote("01", 100n)],
            estimate: estimateOf(await freshAddress(), { "1": 7n }),
        });
        const res = await wallet.transfer({
            asset: A,
            recipient: await freshAddress(),
            amount: circuitAmount(30n),
        });
        expect(res.fees).toEqual({
            protocol: null,
            relayer: { asset: A, amount: 7n, baseUnits: 7n },
        });
        expect(res.amount).toEqual({ asset: A, amount: 30n, baseUnits: 30n });
        expect(res.change).toBe(63n);
    });

    it("is null when the relayer charges nothing", async () => {
        const { wallet } = await harness({
            notes: [storedNote("01", 100n)],
            estimate: estimateOf(undefined, { "1": 7n }),
        });
        const res = await wallet.transfer({
            asset: A,
            recipient: await freshAddress(),
            amount: circuitAmount(30n),
        });
        expect(res.fees.relayer).toBeNull();
    });
});

describe("spendableMax", () => {
    const notes = () => [
        storedNote("01", 100n, { asset: A }),
        storedNote("02", 90n, { asset: A }),
        storedNote("03", 80n, { asset: A }),
        storedNote("04", 70n, { asset: A }),
        storedNote("05", 60n, { asset: A }),
        storedNote("06", 50n, { asset: B }),
    ];

    it("reserves nothing without a kind", async () => {
        const { wallet } = await harness({
            notes: notes(),
            estimate: estimateOf(await freshAddress(), { "1": 7n, "2": 1n }),
        });
        expect((await wallet.spendableMax(A)).max).toBe(340n);
    });

    it("subtracts a same-asset fee and reserves a slot for a cross-asset one", async () => {
        const { wallet } = await harness({
            notes: notes(),
            estimate: estimateOf(await freshAddress(), { "1": 7n, "2": 1n }),
        });
        expect((await wallet.spendableMax(A, { kind: "transfer" })).max).toBe(333n);
        expect((await wallet.spendableMax(A, { kind: "transfer", feeAsset: B })).max).toBe(270n);
        // A caller may lower the arity, never raise it.
        expect((await wallet.spendableMax(A, { selection: { maxInputs: 9 } })).max).toBe(340n);
        expect((await wallet.spendableMax(A, { selection: { maxInputs: 2 } })).max).toBe(190n);
    });

    it("prices the native estimate and refuses an unquoted fee asset", async () => {
        const kinds: string[] = [];
        const { wallet, ctx } = await harness({ notes: notes() });
        const relayer = await freshAddress();
        (ctx.cfg.submitter as { estimate: unknown }).estimate = async (_: bigint, kind: string) => {
            kinds.push(kind);
            return estimateOf(relayer, { "1": 5n });
        };
        expect((await wallet.spendableMax(A, { kind: "withdraw", native: true })).max).toBe(335n);
        expect(kinds).toEqual(["withdrawNative"]);
        await expect(
            wallet.spendableMax(A, { kind: "withdraw", feeAsset: B }),
        ).rejects.toMatchObject({ code: "FEE_ASSET_NOT_QUOTED" });
    });
});
