// `connect()`: one validation pass before anything is built, a lazy prover, the
// key derived last, everything built disposed on failure, HTTP options reaching every service
// client, and a frozen wallet object with bech32m keys and static capabilities.

import { afterEach, describe, expect, it, vi } from "vitest";
import { NETWORKS, type NetworkPreset } from "../../chain/networks.js";
import type { ChainReader } from "../../chain/port.js";
import { evmAddress } from "../../core/brand.js";
import { isWalletError } from "../../errors/guard.js";
import type { EthSigner } from "../../keys/signer.js";
import type { Scanner } from "../../sync/scanner.js";
import { rejection } from "../../test-utils/expect.js";
import { InMemoryNoteStore, type NoteStore } from "../notes/note-store.js";
import { walletInternals } from "../surface/internals.js";
import { connectWatch } from "../watch/connect.js";
import { connect } from "./index.js";
import type { ConnectOptions } from "./options.js";

const bundled = vi.hoisted(() => vi.fn());
vi.mock("../../prover/artifact-paths.js", async (importOriginal) => {
    const real = await importOriginal<typeof import("../../prover/artifact-paths.js")>();
    return {
        ...real,
        bundledProverArtifacts: bundled.mockImplementation(real.bundledProverArtifacts),
    };
});

const pool = vi.hoisted(() => ({
    scanner: { scan: async () => [], dispose: vi.fn(async () => undefined) },
}));
vi.mock("../../sync/worker/pool.js", () => ({
    browserWorkerScanner: () => pool.scanner,
}));

afterEach(() => {
    bundled.mockClear();
    pool.scanner.dispose.mockClear();
});

const PRESET: NetworkPreset = {
    chainId: 31337n,
    maspAddress: `0x${"cc".repeat(20)}`,
    relayerAddress: `0x${"11".repeat(20)}`,
    relayerUrl: "http://relayer.test",
    fmdUrl: "http://fmd.test",
    treeDepth: 10,
};

/** A reader that is never expected to be called by `connect` itself. */
const reader = { chainId: async () => 31337n } as unknown as ChainReader;

function spyScanner(): Scanner & { dispose: ReturnType<typeof vi.fn> } {
    return { scan: async () => [], dispose: vi.fn(async () => undefined) };
}

describe("connect: validation", () => {
    it("reports every problem at once, before any prompt", async () => {
        const signer = {
            chainId: 1n,
            getAddress: async () => evmAddress(`0x${"22".repeat(20)}`),
            signTypedData: vi.fn(async () => `0x${"00".repeat(65)}`),
        } as unknown as EthSigner & { signTypedData: ReturnType<typeof vi.fn> };
        const err = await rejection(
            connect({
                network: "base",
                signer,
                prover: { backend: "gpu" as "wasm" },
                scanner: 7 as unknown as "inline",
            }),
        );
        expect(isWalletError(err, "WALLET_CONFIG")).toBe(true);
        const missing = (err as { missing: string[] }).missing.join("\n");
        expect(missing).toMatch(/rpcUrl/);
        expect(missing).toMatch(/prover\.backend/);
        expect(missing).toMatch(/scanner/);
        expect(signer.signTypedData).not.toHaveBeenCalled();
    });

    it("refuses two chain layers and two key sources at runtime", async () => {
        const err = await rejection(
            connect({
                network: PRESET,
                reader,
                readOnly: true,
                nsk: 1n,
                mnemonic: "abandon",
            } as unknown as ConnectOptions),
        );
        const missing = (err as { missing: string[] }).missing.join("\n");
        expect(missing).toMatch(/one chain layer/);
        expect(missing).toMatch(/one key source/);
    });

    it("refuses a layer that holds no key without an explicit source", async () => {
        const err = await rejection(
            connect({ network: PRESET, readOnly: true } as unknown as ConnectOptions),
        );
        expect(isWalletError(err, "WALLET_CONFIG")).toBe(true);
        expect((err as { missing: string[] }).missing.join()).toMatch(/key source/);
    });

    it("names a placeholder network as not deployed, and an unknown one as config", async () => {
        const placeholder = await rejection(
            connect({ network: "sepolia", nsk: 1n, reader } as unknown as ConnectOptions),
        );
        expect(isWalletError(placeholder, "NETWORK_NOT_DEPLOYED")).toBe(true);
        const unknown = await rejection(
            connect({ network: "localnet", nsk: 1n, reader } as unknown as ConnectOptions),
        );
        expect(isWalletError(unknown, "WALLET_CONFIG")).toBe(true);
    });
});

describe("connect: construction", () => {
    it("builds a frozen wallet with bound methods, bech32m keys and static capabilities", async () => {
        const wallet = await connect({ network: PRESET, reader, nsk: 7n, prover: "none" });

        expect(Object.isFrozen(wallet)).toBe(true);
        const { state } = wallet;
        expect(state().version).toBe(0);
        expect(wallet.keys.tier).toBe("spending");
        expect(wallet.keys.viewingKey).toMatch(/^lelantosivk1/);
        expect(wallet.keys.fullViewingKey).toMatch(/^lelantosfvk1/);
        expect(JSON.stringify(wallet.keys)).not.toMatch(/nsk/);
        expect(wallet.capabilities).toEqual({
            prove: false,
            deposit: false,
            depositAllowance: false,
            nativeDeposit: false,
            nativeWithdraw: false,
            swap: false,
        });
        expect(walletInternals(wallet).keys.nsk).toBe(7n);
        await wallet.dispose();
    });

    it("does no artifact I/O until the first proof or warmProver", async () => {
        const wallet = await connect({ network: PRESET, reader, nsk: 7n });
        expect(bundled).not.toHaveBeenCalled();
        expect(wallet.capabilities.prove).toBe(true);

        // Resolution runs now. Refused here so the test downloads and parses nothing.
        bundled.mockRejectedValueOnce(new Error("no artifacts in this test"));
        await expect(wallet.warmProver()).rejects.toThrow(/no artifacts/);
        expect(bundled).toHaveBeenCalledOnce();
        await wallet.dispose();
    });

    it('rejects warmProver with PROVER_UNAVAILABLE for prover: "none"', async () => {
        const wallet = await connect({ network: PRESET, reader, nsk: 7n, prover: "none" });
        const err = await rejection(wallet.warmProver());
        expect(isWalletError(err, "PROVER_UNAVAILABLE")).toBe(true);
        await wallet.dispose();
    });

    it("builds a read-only chain layer for the anvil preset from its own rpcUrl", async () => {
        const wallet = await connect({ network: "anvil", readOnly: true, nsk: 7n, prover: "none" });
        expect(wallet.capabilities.deposit).toBe(false);
        expect(NETWORKS.anvil.rpcUrl).toBe("http://localhost:8545");
        await wallet.dispose();
    });

    it("derives the key last and disposes only what it built when a later step fails", async () => {
        const scanner = spyScanner();
        const prover = { prove: async () => ({}) as never, dispose: vi.fn(async () => undefined) };
        const broken: NoteStore = {
            load: async () => {
                throw new Error("disk gone");
            },
            save: async () => undefined,
        };
        const signer = {
            chainId: 31337n,
            getAddress: async () => evmAddress(`0x${"22".repeat(20)}`),
            signTypedData: vi.fn(async () => `0x${"00".repeat(65)}`),
        } as unknown as EthSigner & { signTypedData: ReturnType<typeof vi.fn> };

        const err = await rejection(
            connect({
                network: { ...PRESET, rpcUrl: "http://127.0.0.1:1" },
                signer,
                scanner,
                prover,
                storage: { notes: broken },
            }),
        );

        expect(isWalletError(err, "INTERNAL")).toBe(true);
        expect((err as Error).message).toMatch(/disk gone/);
        expect(signer.signTypedData).not.toHaveBeenCalled();
        // Caller-supplied: the caller releases them.
        expect(scanner.dispose).not.toHaveBeenCalled();
        expect(prover.dispose).not.toHaveBeenCalled();

        // A pool `connect` spawned from `{ workers }` is its own to release.
        const again = await rejection(
            connect({
                network: PRESET,
                reader,
                nsk: 7n,
                prover: "none",
                scanner: { workers: () => ({}) as never },
                storage: { notes: broken },
            }),
        );
        expect((again as Error).message).toMatch(/disk gone/);
        expect(pool.scanner.dispose).toHaveBeenCalledOnce();
    });
});

describe("connect: HTTP options", () => {
    it("reach the relayer and FMD clients with headers, retries and a service-tagged onRetry", async () => {
        const seen: { url: string; headers: Record<string, string> }[] = [];
        const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
            seen.push({
                url: String(url),
                headers: (init?.headers ?? {}) as Record<string, string>,
            });
            return new Response("unavailable", { status: 503 });
        }) as unknown as typeof fetch;
        const onRetry = vi.fn();

        const wallet = await connect({
            network: PRESET,
            reader,
            nsk: 7n,
            prover: "none",
            storage: { notes: new InMemoryNoteStore() },
            http: { fetch: fetchImpl, headers: { "x-api-key": "k" }, retries: 1, onRetry },
        });

        await wallet.quoteFee("transfer").catch(() => undefined);
        await wallet.sync({ scope: "notes" }).catch(() => undefined);

        const relayer = seen.filter((s) => s.url.startsWith("http://relayer.test"));
        const fmd = seen.filter((s) => s.url.startsWith("http://fmd.test"));
        expect(relayer.length).toBe(2);
        expect(fmd.length).toBeGreaterThanOrEqual(2);
        for (const s of [...relayer, ...fmd]) expect(s.headers["x-api-key"]).toBe("k");
        const services = onRetry.mock.calls.map(([info]) => (info as { service: string }).service);
        expect(services).toContain("relayer");
        expect(services).toContain("fmd");
        await wallet.dispose();
    });
});

describe("wallet lifecycle", () => {
    it("leaves a caller-supplied scanner and prover to the caller on dispose", async () => {
        const scanner = spyScanner();
        const prover = { prove: async () => ({}) as never, dispose: vi.fn(async () => undefined) };
        const wallet = await connect({ network: PRESET, reader, nsk: 7n, prover, scanner });

        await wallet.dispose();

        expect(scanner.dispose).not.toHaveBeenCalled();
        expect(prover.dispose).not.toHaveBeenCalled();
        expect(wallet.state().disposed).toBe(true);
    });

    it("disposes once, supports await using, then rejects every method", async () => {
        const wallet = await connect({
            network: PRESET,
            reader,
            nsk: 7n,
            prover: "none",
            scanner: { workers: () => ({}) as never, size: 2 },
        });
        const scanner = pool.scanner;
        const seen: boolean[] = [];
        wallet.subscribe((s) => seen.push(s.disposed));

        {
            await using scoped = wallet;
            expect(scoped.address).toMatch(/^lelantos1/);
        }
        await wallet.dispose();

        expect(scanner.dispose).toHaveBeenCalledOnce();
        expect(seen).toEqual([true]);
        expect(wallet.state().disposed).toBe(true);
        const err = await rejection(wallet.notes());
        expect(isWalletError(err, "UNSUPPORTED_OPERATION")).toBe(true);
    });
});

describe("connectWatch ownership", () => {
    it("disposes a pool it built but not a caller-supplied scanner", async () => {
        const wallet = await connect({ network: PRESET, reader, nsk: 7n, prover: "none" });
        const viewingKey = wallet.keys.fullViewingKey;
        await wallet.dispose();

        const injected = spyScanner();
        const watched = await connectWatch({ network: PRESET, viewingKey, scanner: injected });
        await watched.dispose();
        expect(injected.dispose).not.toHaveBeenCalled();

        const pooled = await connectWatch({
            network: PRESET,
            viewingKey,
            scanner: { workers: () => ({}) as never },
        });
        await pooled.dispose();
        expect(pool.scanner.dispose).toHaveBeenCalledOnce();
    });
});
