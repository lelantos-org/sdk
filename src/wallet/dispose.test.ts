import { describe, expect, it, vi } from "vitest";
import { testWallet } from "../test-utils/wallet.js";

// Ownership: a wallet disposes only what the SDK built. A caller-supplied `Scanner` / `Prover` may
// be shared across wallets (webapp: one tab-wide `WorkerProver`), so `dispose()` and a failed build
// must leave it running. Built resources (a `ProverConfig` prover, a `{ workers }` pool) are the
// wallet's and are released with it.

const built = vi.hoisted(() => ({
    dispose: vi.fn(async () => undefined),
    preload: vi.fn(async () => undefined),
}));
vi.mock("../prover/worker-client.js", () => ({
    WorkerProver: class {
        prove = async () => ({}) as never;
        preload = built.preload;
        dispose = built.dispose;
    },
}));

const WORKER_CONFIG = {
    artifacts: { circuit: "/c.wasm", zkey: "/c.zkey" },
    worker: () => ({}) as never,
};

describe("wallet.dispose", () => {
    // A caller-supplied scanner and prover, and `await using`, are covered in `connect/connect.test.ts`.
    it("releases a prover it built from a ProverConfig", async () => {
        built.dispose.mockClear();
        const { wallet } = await testWallet({ prover: WORKER_CONFIG });
        await wallet.warmProver();

        await wallet.dispose();

        expect(built.dispose).toHaveBeenCalledOnce();
    });

    it("works on backends that hold nothing", async () => {
        // `dispose` is optional on both ports: the in-process scanner and the
        // snarkjs prover hold only GC-reclaimable resources.
        const { wallet } = await testWallet({ scanner: { scan: async () => [] } });
        await expect(wallet.dispose()).resolves.toBeUndefined();
    });

    it("does not start a prover build just to dispose it", async () => {
        built.dispose.mockClear();
        const { wallet } = await testWallet({ prover: WORKER_CONFIG });
        await wallet.dispose();
        expect(built.dispose).not.toHaveBeenCalled();
    });
});

describe("createWallet failure", () => {
    it("leaves a caller-supplied scanner and prover running", async () => {
        const scanner = { scan: async () => [], dispose: vi.fn(async () => undefined) };
        const prover = { prove: async () => ({}) as never, dispose: vi.fn(async () => undefined) };
        const noteStore = {
            load: async () => {
                throw new Error("disk gone");
            },
            save: async () => undefined,
        };

        await expect(testWallet({ scanner, prover, noteStore })).rejects.toThrow(/disk gone/);

        expect(scanner.dispose).not.toHaveBeenCalled();
        expect(prover.dispose).not.toHaveBeenCalled();
    });
});
