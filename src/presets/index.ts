// Single-call preset constructors wrapping `Wallet.create`.
//
// `fastWallet` for browsers; `nodeWallet` for Node tests/scripts where Web
// Workers cost more than they save.

import type { KeySource } from "../keys/key-source.js";
import { bundledProverArtifacts, resolveArtifacts } from "../prover/artifacts.js";
import { preloadWasm } from "../prover/preload.js";
import type { ProverPaths } from "../prover/types.js";
import { type BrowserWorkerScannerOpts, browserWorkerScanner } from "../sync/worker/pool.js";
import type { WalletConfig } from "../wallet/config.js";
import { Wallet } from "../wallet/index.js";

// Dynamic import keeps the wasm-pack prover + rayon worker glue out of
// bundles that don't instantiate `fastWallet`/`nodeWallet` (~360 KB saved).
async function buildWasmProver(paths: ProverPaths) {
    const { WasmProver } = await import("../prover/wasm-prover.js");
    return WasmProver.build(paths);
}

/**
 * `config.proverPaths` if set, else bundled artifacts (env dir / companion
 * package). `undefined` defers to `Wallet.create` → `defaultProver`.
 */
async function resolveProverPaths(config: { proverPaths?: ProverPaths }) {
    if (config.proverPaths) return config.proverPaths;
    try {
        return resolveArtifacts(await bundledProverArtifacts()) as ProverPaths;
    } catch {
        return undefined;
    }
}

/** @internal */
export interface FastWalletOpts {
    keys: KeySource;
    /**
     * Standard `WalletConfig` minus the bits the preset wires for you
     * (`scanner`, `prover`).
     */
    config: Omit<WalletConfig, "scanner" | "prover">;
    /** Worker pool size. Default `navigator.hardwareConcurrency` clamped 2-8. */
    workerSize?: number;
    /**
     * Worker pool config. `workerUrl` required — pass from your ESM call
     * site: `new URL("@lelantos-org/sdk/scanner-worker", import.meta.url)`.
     */
    workerOpts: Omit<BrowserWorkerScannerOpts, "size">;
    /**
     * Skip eager WASM warmup. Saves ~10-50ms construction time but pushes
     * first-decrypt latency onto the first `wallet.sync()`.
     */
    skipWarmup?: boolean;
}

/**
 * Browser-optimal wallet: WasmJubjub + WorkerPool scanner + WasmProver,
 * pre-warmed.
 *
 * @internal
 */
export async function fastWallet(opts: FastWalletOpts): Promise<Wallet> {
    const paths = await resolveProverPaths(opts.config);
    if (!opts.skipWarmup) await preloadWasm({ prover: !!paths });

    const scanner = browserWorkerScanner({
        ...opts.workerOpts,
        size: opts.workerSize,
    });

    const prover = paths ? await buildWasmProver(paths) : undefined;

    return Wallet.create(opts.keys, {
        ...opts.config,
        scanner,
        ...(prover ? { prover } : {}),
    });
}

/** @internal */
export interface NodeWalletOpts {
    keys: KeySource;
    config: Omit<WalletConfig, "scanner" | "prover">;
    skipWarmup?: boolean;
}

/**
 * Node-optimal wallet: WasmJubjub + in-process LocalScanner (no worker
 * overhead) + WasmProver, pre-warmed.
 */
export async function nodeWallet(opts: NodeWalletOpts): Promise<Wallet> {
    const paths = await resolveProverPaths(opts.config);
    if (!opts.skipWarmup) await preloadWasm({ prover: !!paths });

    const prover = paths ? await buildWasmProver(paths) : undefined;

    return Wallet.create(opts.keys, {
        ...opts.config,
        ...(prover ? { prover } : {}),
    });
}

export type { ProverPaths };
