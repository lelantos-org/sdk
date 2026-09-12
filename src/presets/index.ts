// Single-call preset constructors.
//
// `fastWallet` for browsers; `nodeWallet` for Node tests/scripts where Web
// Workers cost more than they save.

import type { CircuitShape } from "../core/shape.js";
import type { KeySource } from "../keys/key-source.js";
import { getLogger } from "../log/logger.js";
import { bundledProverArtifacts, resolveArtifacts } from "../prover/artifacts.js";
import { preloadWasm } from "../prover/preload.js";
import type { ProverPaths } from "../prover/types.js";
import { type BrowserWorkerScannerOpts, browserWorkerScanner } from "../sync/worker/pool.js";
import type { WalletConfig } from "../wallet/config.js";
import { connect } from "../wallet/connect/index.js";
import type { ConnectOptions } from "../wallet/connect/options.js";
import { Wallet } from "../wallet/index.js";

// Dynamic import keeps the wasm-pack prover + rayon worker glue out of
// bundles that don't instantiate `nodeWallet` (~360 KB saved).
const log = getLogger("lelantos:presets");

async function buildWasmProver(paths: ProverPaths) {
    const { WasmProver } = await import("../prover/wasm-prover.js");
    return WasmProver.build(paths);
}

/**
 * `config.proverPaths` if set, else bundled artifacts (env dir / companion
 * package). `undefined` defers to `Wallet.create` → `defaultProver`.
 */
async function resolveProverPaths(config: {
    proverPaths?: ProverPaths | undefined;
    shape?: CircuitShape | undefined;
}) {
    if (config.proverPaths) return config.proverPaths;
    try {
        return resolveArtifacts(
            await bundledProverArtifacts({ shape: config.shape }),
        ) as ProverPaths;
    } catch {
        return undefined;
    }
}

/**
 * Everything {@link connect} takes, plus the scanner worker pool. Network
 * resolution, key derivation, chain adapter and prover are `connect`'s, so a
 * browser call is not a longer call than a Node one.
 */
export type FastWalletOpts = ConnectOptions & {
    /**
     * Scanner worker pool. `pool.worker` must spawn the worker from a literal
     * expression in your own module — see {@link BrowserWorkerScannerOpts.worker}.
     *
     * ```ts
     * const wallet = await fastWallet({
     *     network: "base",
     *     provider: window.ethereum,
     *     address,
     *     rpcUrl,
     *     pool: {
     *         worker: () =>
     *             new Worker(new URL("@lelantos-org/sdk/scanner-worker", import.meta.url), {
     *                 type: "module",
     *             }),
     *     },
     * });
     * ```
     */
    pool: BrowserWorkerScannerOpts;
    /** Supplied by the pool above. */
    scanner?: never;
};

/**
 * Browser wallet: {@link connect} plus a `WorkerPoolScanner`, so note scanning
 * runs off the main thread.
 *
 * Disposes the pool if construction fails — the workers are live threads, each
 * holding a jubjub wasm instance, and a `connect` that throws after they spawn
 * would otherwise leak one pool per attempt.
 *
 * Call `wallet.dispose()` when abandoning the wallet. Letting it go out of
 * scope does not release the workers.
 */
export async function fastWallet(opts: FastWalletOpts): Promise<Wallet> {
    const { pool, ...rest } = opts;
    const scanner = browserWorkerScanner(pool);
    try {
        return await connect({ ...rest, scanner });
    } catch (err) {
        // Settled, not raced: a failing teardown must not replace the
        // `connect` error that explains why we are here.
        await scanner.dispose().catch((e: unknown) => {
            log.warn("scanner dispose failed after connect error", { err: e });
        });
        throw err;
    }
}

export interface NodeWalletOpts {
    keys: KeySource;
    config: Omit<WalletConfig, "scanner" | "prover">;
    skipWarmup?: boolean | undefined;
}

/**
 * Node-optimal wallet: WasmJubjub + in-process LocalScanner (no worker
 * overhead) + WasmProver, pre-warmed.
 *
 * Takes an explicit `WalletConfig` rather than {@link ConnectOptions} on
 * purpose: a local stack points at arbitrary FMD and relayer URLs, which a
 * builtin `NetworkPreset` does not carry. `connect({ network: <custom
 * NetworkPreset> })` is the other way to spell that.
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
