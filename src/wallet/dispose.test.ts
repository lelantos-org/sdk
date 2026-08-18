import { describe, expect, it, vi } from "vitest";
import { testWallet } from "./wallet-test-utils.js";

// `Scanner.dispose` existed with no caller anywhere, and `WorkerPoolScanner`
// spawns 2-8 workers per wallet — so an app rebuilding its wallet on an
// account or network switch leaked a whole pool, and its wasm heaps, each time.

describe("Wallet.dispose", () => {
    it("releases the scanner and the prover", async () => {
        const scanner = { scan: async () => [], dispose: vi.fn(async () => undefined) };
        const prover = { prove: async () => ({}) as never, dispose: vi.fn(async () => undefined) };
        const { wallet } = await testWallet({ scanner, prover });

        await wallet.dispose();

        expect(scanner.dispose).toHaveBeenCalledOnce();
        expect(prover.dispose).toHaveBeenCalledOnce();
    });

    it("is idempotent", async () => {
        const scanner = { scan: async () => [], dispose: vi.fn(async () => undefined) };
        const { wallet } = await testWallet({ scanner });

        await wallet.dispose();
        await wallet.dispose();

        expect(scanner.dispose).toHaveBeenCalledOnce();
    });

    it("works on backends that hold nothing", async () => {
        // `dispose` is optional on both ports: the in-process scanner and the
        // snarkjs prover have nothing a GC will not reclaim.
        const { wallet } = await testWallet({ scanner: { scan: async () => [] } });
        await expect(wallet.dispose()).resolves.toBeUndefined();
    });

    it("still releases the prover when the scanner throws", async () => {
        const scanner = {
            scan: async () => [],
            dispose: vi.fn(async () => {
                throw new Error("worker already gone");
            }),
        };
        const prover = { prove: async () => ({}) as never, dispose: vi.fn(async () => undefined) };
        const { wallet } = await testWallet({ scanner, prover });

        // Settled, not raced: one backend failing must not strand the other.
        await expect(wallet.dispose()).resolves.toBeUndefined();
        expect(prover.dispose).toHaveBeenCalledOnce();
    });
});
