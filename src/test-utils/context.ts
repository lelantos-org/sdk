// A `WalletContext` for operation tests: every pluggable stubbed and every side effect recorded.
//
// Operations take the context rather than `Wallet`, so these tests need no chain, relayer, prover
// or note store. For a real `Wallet` over stubs, see `./wallet.ts`.

import { createMutex } from "../core/async.js";
import { randomJubjubScalar } from "../core/random.js";
import { Jubjub } from "../crypto/jubjub-wasm/index.js";
import { Poseidon } from "../crypto/poseidon.js";
import { addressFromSpendingKey, buildSpendingKey } from "../keys/keys.js";
import { getLogger } from "../log/logger.js";
import type { EstimateResponse } from "../protocol/responses.js";
import { type CircuitShape, DEFAULT_SHAPE } from "../protocol/shape.js";
import type { ProveResult, Prover } from "../prover/types.js";
import type { AssetInfo } from "../wallet/assets/info.js";
import type { WalletContext } from "../wallet/context.js";
import { NoteLeases } from "../wallet/notes/leases.js";
import type { StoredNote } from "../wallet/notes/note-store.js";
import { NullifierMemo } from "../wallet/notes/sync-ops.js";
import { stubTreeStore } from "./wallet.js";

export const TEST_RELAYER_ADDR = "0x0000000000000000000000000000000000000001";

/** A Groth16-shaped proof no verifier would accept; enough for everything before the chain. */
export const FAKE_PROOF: ProveResult = {
    proof: { pi_a: ["1"], pi_b: [["2"]], pi_c: ["3"], protocol: "groth16", curve: "bn128" },
    publicSignals: [],
};

export interface TestCtxOpts {
    /** The wallet's stored notes, read live: mutate the array to change what selection sees. */
    notes?: StoredNote[];
    shape?: CircuitShape;
    /** Chain layer. Default: one reporting a native adapter and nothing else. */
    chain?: unknown;
    /** What the relayer quotes. Absent: the submitter cannot quote, so no fee is charged. */
    estimate?: EstimateResponse;
    /**
     * Asset lookup. Default: a zero-fee, scale-1 stand-in keyed by id, so tests cover slot wiring
     * rather than fee arithmetic.
     */
    resolveAsset?: (ref: unknown) => Promise<unknown>;
    /** Merged over the stub config: `quoterUrl`, `http`, `swapWrapperAddress`, … */
    cfg?: Record<string, unknown>;
}

export const NATIVE_ADAPTER_ADDR = "0x00000000000000000000000000000000000ada9e";

/**
 * A context over stubs, and the records of what the operation did.
 *
 * The selector takes up to two unspent notes of the asset and throws when they fall short. The
 * prover records its last witness. `submit.impl` is replaceable to make a submit fail.
 */
export async function makeTestCtx(opts: TestCtxOpts = {}) {
    const P = await Poseidon.build();
    const J = await Jubjub.build();
    const keys = buildSpendingKey(P, J, randomJubjubScalar());
    const address = addressFromSpendingKey(J, keys);
    const notes = opts.notes ?? [];

    const submitted: unknown[] = [];
    const markedSpent: string[][] = [];
    const reserved: string[][] = [];
    const witness: { last?: Record<string, unknown> } = {};
    const submit = {
        impl: async (_payload: unknown): Promise<{ txHash: string }> => ({ txHash: "0xdeadbeef" }),
    };
    const prover: Prover = {
        async prove(input) {
            witness.last = input as Record<string, unknown>;
            return FAKE_PROOF;
        },
    };
    // The spend path reconciles the tree with the chain; tests stub the outcome.
    const treeStore = stubTreeStore();
    const noteCache = {
        get notes() {
            return notes;
        },
        markSpent: async (ids: string[]) => {
            markedSpent.push(ids);
        },
        markPendingSpend: async (ids: string[]) => {
            reserved.push(ids);
        },
    };
    const resolve =
        opts.resolveAsset ??
        (async (ref: unknown): Promise<Partial<AssetInfo>> => ({
            id: BigInt(ref as bigint) as AssetInfo["id"],
            token: "0x0000000000000000000000000000000000000000" as AssetInfo["token"],
            scale: 1n,
            disabled: false,
            depositBps: 0n,
            withdrawBps: 0n,
            decimals: 18,
            ladder: [],
        }));

    const ctx = {
        P,
        J,
        keys,
        address,
        cfg: {
            chainId: 31337n,
            treeDepth: 4,
            relayerAddress: TEST_RELAYER_ADDR,
            feeBps: 0n,
            shape: opts.shape ?? DEFAULT_SHAPE,
            chain: opts.chain ?? { nativeAdapterAddress: () => NATIVE_ADAPTER_ADDR },
            prover,
            submitter: {
                async submit(payload: unknown) {
                    submitted.push(payload);
                    return submit.impl(payload);
                },
                ...(opts.estimate ? { estimate: async () => opts.estimate } : {}),
            },
            selector: {
                select(all: readonly StoredNote[], asset: bigint, target: bigint) {
                    const picked = all
                        .filter((n) => !n.spent && BigInt(n.asset) === asset)
                        .slice(0, 2);
                    const sum = picked.reduce((a, n) => a + BigInt(n.value), 0n);
                    if (sum < target) throw new Error("fixture: insufficient");
                    return { plan: "direct" as const, notes: picked, sum };
                },
            },
            treeStore,
            ...opts.cfg,
        },
        notes: noteCache,
        assets: { resolve, resolveVerified: resolve, refresh: resolve, list: async () => [] },
        locks: { sync: createMutex() },
        leases: new NoteLeases(),
        relayerInfo: {
            tokens: undefined,
            refundAddress: async () => undefined,
            swapWrapperAddress: async () => undefined,
        },
        nullifiers: new NullifierMemo(P, keys.nk),
        log: getLogger("lelantos:test"),
        autoConsolidate: async () => undefined,
    } as unknown as WalletContext;

    return {
        ctx,
        address,
        prover,
        submit,
        submitted,
        markedSpent,
        reserved,
        witness,
        treeStore,
        noteCache,
        leases: ctx.leases,
    };
}
