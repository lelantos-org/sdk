// Single-call preset constructors wrapping `Wallet.create`.
//
// `fastWallet` for browsers; `nodeWallet` for Node tests/scripts where Web
// Workers cost more than they save.

import { preloadWasm } from "./preload.js";
import type { ProverPaths } from "./prover.js";
import type { WalletConfig } from "./wallet/config.js";
import { Wallet } from "./wallet/index.js";
import type { KeySource } from "./wallet/key-source.js";
import {
    type BrowserWorkerScannerOpts,
    browserWorkerScanner,
} from "./wallet/scanner-worker-pool.js";

// Dynamic import keeps the wasm-pack prover + rayon worker glue out of
// bundles that don't instantiate `fastWallet`/`nodeWallet` (~360 KB saved).
async function buildWasmProver(paths: ProverPaths) {
    const { WasmProver } = await import("./wallet/wasm-prover.js");
    return WasmProver.build(paths);
}

export interface FastWalletOpts {
    keys: KeySource;
    /// Standard `WalletConfig` minus the bits the preset wires for you
    /// (`scanner`, `prover`).
    config: Omit<WalletConfig, "scanner" | "prover">;
    /// Worker pool size. Default `navigator.hardwareConcurrency` clamped 2-8.
    workerSize?: number;
    /// Worker pool config. `workerUrl` required — pass from your ESM call
    /// site: `new URL("@lelantos-org/sdk/scanner-worker", import.meta.url)`.
    workerOpts: Omit<BrowserWorkerScannerOpts, "size">;
    /// Skip eager WASM warmup. Saves ~10-50ms construction time but pushes
    /// first-decrypt latency onto the first `wallet.sync()`.
    skipWarmup?: boolean;
}

/// Browser-optimal wallet: WasmJubjub + WorkerPool scanner + WasmProver,
/// pre-warmed.
export async function fastWallet(opts: FastWalletOpts): Promise<Wallet> {
    if (!opts.skipWarmup) await preloadWasm({ prover: !!opts.config.proverPaths });

    const scanner = browserWorkerScanner({
        ...opts.workerOpts,
        size: opts.workerSize,
    });

    const prover = opts.config.proverPaths
        ? await buildWasmProver(opts.config.proverPaths)
        : undefined;

    return Wallet.create(opts.keys, {
        ...opts.config,
        scanner,
        ...(prover ? { prover } : {}),
    });
}

export interface NodeWalletOpts {
    keys: KeySource;
    config: Omit<WalletConfig, "scanner" | "prover">;
    skipWarmup?: boolean;
}

/// Node-optimal wallet: WasmJubjub + in-process LocalScanner (no worker
/// overhead) + WasmProver, pre-warmed.
export async function nodeWallet(opts: NodeWalletOpts): Promise<Wallet> {
    if (!opts.skipWarmup) await preloadWasm({ prover: !!opts.config.proverPaths });

    const prover = opts.config.proverPaths
        ? await buildWasmProver(opts.config.proverPaths)
        : undefined;

    return Wallet.create(opts.keys, {
        ...opts.config,
        ...(prover ? { prover } : {}),
    });
}

export type { ProverPaths };
