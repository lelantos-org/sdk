// Single-call preset constructors. Wrap `Wallet.create` with the recommended
// stack so app code stays one line.
//
// Pick `fastWallet` for browser apps; `nodeWallet` for Node tests / scripts
// where Web Workers cost more than they save (sync workload, no event loop
// to free up).

import { Wallet } from "./wallet";
import type { WalletConfig } from "./wallet/config";
import type { KeySource } from "./wallet/key-source";
import { browserWorkerScanner, type BrowserWorkerScannerOpts } from "./wallet/scanner-browser";
import { WasmProver } from "./wallet/wasm-prover";
import type { ProverPaths } from "./prover";
import { preloadWasm } from "./preload";

export interface FastWalletOpts {
    keys: KeySource;
    /// Standard `WalletConfig` minus the bits the preset wires for you
    /// (`scanner`, `prover`).
    config: Omit<WalletConfig, "scanner" | "prover">;
    /// Worker pool size. Default `navigator.hardwareConcurrency` clamped 2-8.
    workerSize?: number;
    /// Worker pool config. `workerUrl` required — pass from your ESM call
    /// site: `new URL("@lelantos/sdk/scanner-worker", import.meta.url)`.
    workerOpts: Omit<BrowserWorkerScannerOpts, "size">;
    /// Skip eager WASM warmup. Saves ~10-50ms construction time but pushes
    /// first-decrypt latency onto the first `wallet.sync()`.
    skipWarmup?: boolean;
}

/// Browser-optimal wallet: WasmJubjub + WorkerPool scanner + WasmProver,
/// pre-warmed. Single call replaces ~15 lines of manual wiring.
export async function fastWallet(opts: FastWalletOpts): Promise<Wallet> {
    if (!opts.skipWarmup) await preloadWasm({ prover: !!opts.config.proverPaths });

    const scanner = browserWorkerScanner({
        ...opts.workerOpts,
        size: opts.workerSize,
    });

    const prover = opts.config.proverPaths
        ? await WasmProver.build(opts.config.proverPaths)
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
        ? await WasmProver.build(opts.config.proverPaths)
        : undefined;

    return Wallet.create(opts.keys, {
        ...opts.config,
        ...(prover ? { prover } : {}),
    });
}

export type { ProverPaths };
