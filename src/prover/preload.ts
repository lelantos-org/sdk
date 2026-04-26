// Eager WASM warmup. Idempotent — modules cache themselves after first build.

import { WasmJubjub } from "../crypto/jubjub-wasm/index.js";
import type { ProverPaths } from "./types.js";

/** @internal */
export interface PreloadOpts {
    /**
     * Warm the prover wasm too. Default true. Set false on read-only wallets
     * (display balances, scan only) to skip ~370KB prover download. Pass
     * `ProverPaths` to also fetch + parse the artifacts (full build, cached).
     */
    prover?: boolean | ProverPaths;
}

/**
 * Build all WASM modules used by the SDK. Returns once they're ready for
 * hot-path use. Safe to call before `Wallet.create`.
 *
 * @internal
 */
export async function preloadWasm(opts: PreloadOpts = {}): Promise<void> {
    const tasks: Promise<unknown>[] = [WasmJubjub.build()];
    if (opts.prover !== false) {
        const { WasmProver } = await import("./wasm-prover.js");
        tasks.push(WasmProver.preload(typeof opts.prover === "object" ? opts.prover : undefined));
    }
    await Promise.all(tasks);
}
