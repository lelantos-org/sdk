// The error contract of the public wallet surface: every rejection is a
// `WalletError` (checked with the duplicate-bundle-safe `isWalletError`), except
// the reason of the caller's own `AbortSignal`, which passes through untouched.
//
// Each public method is driven with an invalid input, or with a plugin that
// misbehaves by throwing something that is not a `WalletError`.

import { describe, expect, it } from "vitest";
import type { ChainAdapter } from "../chain/port.js";
import { assetId, circuitAmount, evmAddress } from "../core/brand.js";
import { isWalletError } from "../errors/guard.js";
import type { NullifierStore } from "../sync/nullifier-store.js";
import { rejection } from "../test-utils/expect.js";
import { storedNote, testWallet } from "../test-utils/wallet.js";
import type { NoteStore } from "./notes/note-store.js";
import type { SwapQuote } from "./types/quotes.js";
import { createWatchWallet } from "./watch/watch-wallet.js";

const TOKEN = evmAddress(`0x${"aa".repeat(20)}`);

/** A read-only chain that knows asset 1 and nothing else. */
const chain = {
    chainId: async () => 31337n,
    blockNumber: async () => 100,
    maspAddress: async () => evmAddress(`0x${"cc".repeat(20)}`),
    fetchAsset: async (id: bigint) => {
        if (id !== 1n) throw Object.assign(new Error("execution reverted"), { name: "Error" });
        return { token: TOKEN, scale: 1n, disabled: false, depositBps: 0n, withdrawBps: 0n };
    },
    tokenMeta: async () => ({ symbol: "T1", decimals: 18 }),
    nativeAdapterAddress: () => undefined,
} as unknown as ChainAdapter;

const bad = "not-an-address";
const zero = circuitAmount(0n);
const five = circuitAmount(5n);

describe("wallet object: every rejection is a WalletError", () => {
    const cases: ReadonlyArray<
        readonly [
            method: string,
            call: (w: Awaited<ReturnType<typeof testWallet>>["wallet"]) => unknown,
            code?: string,
        ]
    > = [
        ["deposit", (w) => w.deposit({ asset: 1n, amount: five }), "NO_EVM_ACCOUNT"],
        ["deposit (amount)", (w) => w.deposit({ asset: 1n, amount: zero }), "INVALID_ARGUMENT"],
        [
            "deposit (number)",
            (w) => w.deposit({ asset: 1n, amount: 1.5 as unknown as string }),
            "INVALID_ARGUMENT",
        ],
        ["cancelDeposit", (w) => w.cancelDeposit({ depositId: 1n }), "NO_EVM_ACCOUNT"],
        [
            "transfer (amount)",
            (w) => w.transfer({ asset: 1n, recipient: bad, amount: zero }),
            "INVALID_ARGUMENT",
        ],
        [
            "transfer (recipient)",
            (w) => w.transfer({ asset: 1n, recipient: bad, amount: five }),
            "INVALID_ARGUMENT",
        ],
        [
            "transfer (funds)",
            (w) => w.transfer({ asset: 1n, recipient: w.address, amount: five }),
            "INSUFFICIENT_BALANCE",
        ],
        [
            "transfer (opId)",
            (w) => w.transfer({ asset: 1n, recipient: w.address, amount: five, opId: "no spaces" }),
            "INVALID_ARGUMENT",
        ],
        [
            "withdraw",
            (w) => w.withdraw({ recipient: evmAddress(TOKEN), gross: zero, asset: 1n }),
            "INVALID_ARGUMENT",
        ],
        [
            "withdraw (both sides)",
            (w) =>
                w.withdraw({
                    recipient: evmAddress(TOKEN),
                    gross: five,
                    net: five,
                    asset: 1n,
                } as never),
            "INVALID_ARGUMENT",
        ],
        [
            "withdraw (native)",
            (w) =>
                w.withdraw({ recipient: evmAddress(TOKEN), gross: five, asset: 1n, native: true }),
            "UNSUPPORTED_OPERATION",
        ],
        ["swap", (w) => w.swap({ quote: {} as SwapQuote }), "UNSUPPORTED_OPERATION"],
        [
            "quoteSwap",
            (w) => w.quoteSwap({ assetIn: 1n, assetOut: 2n, gross: five, slippageBps: 50 }),
            "UNSUPPORTED_OPERATION",
        ],
        ["quoteDeposit", (w) => w.quoteDeposit({ asset: 1n, amount: five }), "NO_EVM_ACCOUNT"],
        [
            "setupDepositAllowance",
            (w) => w.setupDepositAllowance({ assets: [1n] }),
            "NO_EVM_ACCOUNT",
        ],
        ["asset", (w) => w.asset(""), "INVALID_ARGUMENT"],
        ["asset (unknown id)", (w) => w.asset(999n)],
        ["balance", (w) => w.balance(""), "INVALID_ARGUMENT"],
        ["spendableMax", (w) => w.spendableMax(""), "INVALID_ARGUMENT"],
        [
            "previewWithdraw",
            (w) => w.previewWithdraw({ gross: "-1", asset: 1n }),
            "INVALID_ARGUMENT",
        ],
        ["withdrawDenominations", (w) => w.withdrawDenominations(""), "INVALID_ARGUMENT"],
        ["redenominate", (w) => w.redenominate(""), "INVALID_ARGUMENT"],
        ["sync (scope)", (w) => w.sync({ scope: "everything" as "full" }), "INVALID_ARGUMENT"],
        [
            "awaitCommitments",
            (w) => w.awaitCommitments(null as unknown as string[]),
            "INVALID_ARGUMENT",
        ],
        ["quoteFee", (w) => w.quoteFee("teleport" as "transfer"), "INVALID_ARGUMENT"],
    ];

    for (const [name, call, code] of cases) {
        it(name, async () => {
            const { wallet } = await testWallet({ chain });
            const err = await rejection(() => call(wallet));
            expect(isWalletError(err), String(err)).toBe(true);
            if (code) expect(err).toMatchObject({ code });
            // The method name is recorded for correlation.
            expect((err as { context: { op?: string } }).context.op).toBeDefined();
        });
    }

    it("wraps a misbehaving plugin's bare Error as INTERNAL, keeping it as cause", async () => {
        const boom = new Error("mirror exploded");
        const nullifierStore = {
            sync: async () => {
                throw boom;
            },
            has: () => false,
        } as unknown as NullifierStore;
        const { wallet } = await testWallet({ chain, nullifierStore });

        for (const call of [() => wallet.sync({ scope: "notes" }), () => wallet.sync()]) {
            const err = await rejection(call);
            expect(isWalletError(err, "INTERNAL")).toBe(true);
            expect((err as Error).cause).toBe(boom);
            expect((err as Error).message).toContain("mirror exploded");
        }
    });

    it("wraps a failing note store on reload", async () => {
        const { wallet, noteStore } = await testWallet({ chain });
        // Break the store after the wallet loaded it.
        (noteStore as { load: NoteStore["load"] }).load = async () => {
            throw new TypeError("unreadable");
        };
        const err = await rejection(() => wallet.sync({ scope: "notes", reload: true }));
        expect(isWalletError(err, "INTERNAL")).toBe(true);
    });

    it("wraps a corrupt stored note on the note reads", async () => {
        const corrupt = { ...storedNote("01", 5n), asset: "zz" };
        const { wallet } = await testWallet({ chain, notes: [corrupt] });
        // A snapshot never throws: a corrupt note is left out of it.
        expect(() => wallet.state()).not.toThrow();
        for (const call of [() => wallet.balance(1n), () => wallet.notes({ asset: 1n })]) {
            const err = await rejection(call);
            expect(isWalletError(err, "INTERNAL")).toBe(true);
        }
    });

    it("wraps a chain adapter's bare Error", async () => {
        const broken = {
            ...chain,
            blockNumber: async () => {
                throw new Error("socket hang up");
            },
        } as unknown as ChainAdapter;
        const { wallet } = await testWallet({ chain: broken });
        const err = await rejection(() => wallet.spendableMax(assetId(1n)));
        expect(err).toMatchObject({ code: "INTERNAL", context: { op: "spendableMax" } });
    });

    it("lets the caller's abort reason through unchanged", async () => {
        const reason = new DOMException("user navigated away", "AbortError");
        const ctrl = new AbortController();
        ctrl.abort(reason);
        const nullifierStore = {
            sync: async () => {
                throw reason;
            },
            has: () => false,
        } as unknown as NullifierStore;
        const { wallet } = await testWallet({ chain, nullifierStore });
        const err = await rejection(() => wallet.sync({ signal: ctrl.signal }));
        expect(err).toBe(reason);
    });
});

describe("watch wallet: every rejection is a WalletError", () => {
    it("reports a missing chain reader as WALLET_CONFIG", async () => {
        const { internals } = await testWallet();
        const watch = await createWatchWallet(internals.keys, {
            chainId: 31337n,
            fmdUrl: "http://fmd.invalid",
            noteSource: { listNotes: async () => ({ inputs: [], nextAfter: 0, resumeAfter: 0 }) },
            nullifierStore: {
                sync: async () => undefined,
                has: () => false,
            } as unknown as NullifierStore,
        });
        const err = await rejection(() => watch.asset(1n));
        expect(isWalletError(err, "WALLET_CONFIG")).toBe(true);
        expect(err).toMatchObject({ context: { op: "asset" } });
    });

    it("rejects an unparseable viewing key with INVALID_ARGUMENT", async () => {
        const err = await rejection(() =>
            createWatchWallet("lelantos-view1-nope", {
                chainId: 1n,
                fmdUrl: "http://fmd.invalid",
            }),
        );
        expect(isWalletError(err)).toBe(true);
    });
});
