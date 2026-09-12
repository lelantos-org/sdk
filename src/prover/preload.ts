// Eager WASM warmup. Idempotent — modules cache themselves after first build.

import { WasmJubjub } from "../crypto/jubjub-wasm/index.js";
import { loadWasmProver } from "./load-wasm-prover.js";
import type { ProverPaths } from "./types.js";

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
 * hot-path use.
 *
 * Optional — `connect()` warms eagerly by default. Call it directly to move
 * the cost somewhere you control, such as behind a splash screen or on a
 * route transition before the user reaches a spend form. Idempotent: modules
 * cache themselves after the first build, so a later `connect()` reuses them.
 */
export async function preloadWasm(opts: PreloadOpts = {}): Promise<void> {
    const tasks: Promise<unknown>[] = [WasmJubjub.build()];
    if (opts.prover !== false) {
        const { WasmProver } = await loadWasmProver();
        tasks.push(WasmProver.preload(typeof opts.prover === "object" ? opts.prover : undefined));
    }
    await Promise.all(tasks);
}
