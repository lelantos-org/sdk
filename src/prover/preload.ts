// Eager WASM warmup. Idempotent: modules cache themselves after the first build.

import { Jubjub } from "../crypto/jubjub-wasm/index.js";
import { loadWasmProver } from "./load-wasm-prover.js";
import type { ProverArtifacts } from "./types.js";

export interface PreloadOpts {
    /**
     * Warm the prover wasm too. Default true. Set false for read-only wallets
     * (balances, scanning) to skip the ~370KB prover download. Pass
     * `ProverArtifacts` to also fetch and parse them (full build, cached).
     */
    prover?: boolean | ProverArtifacts;
}

/**
 * Build all WASM modules used by the SDK. Resolves once they are ready.
 *
 * Optional: `connect()` warms eagerly by default. Call directly to control when
 * the cost is paid (e.g. behind a splash screen or on a route transition).
 * Idempotent; a later `connect()` reuses the built modules.
 */
export async function preloadWasm(opts: PreloadOpts = {}): Promise<void> {
    const tasks: Promise<unknown>[] = [Jubjub.build()];
    if (opts.prover !== false) {
        const { WasmProver } = await loadWasmProver();
        tasks.push(WasmProver.preload(typeof opts.prover === "object" ? opts.prover : undefined));
    }
    await Promise.all(tasks);
}
