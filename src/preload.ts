// Eager WASM warmup. Idempotent — modules cache themselves after first build.

import { WasmJubjub } from "./crypto/jubjub-wasm.js";

export interface PreloadOpts {
    /// Warm the prover wasm too. Default true. Set false on read-only wallets
    /// (display balances, scan only) to skip ~370KB prover download.
    prover?: boolean;
}

/// Build all WASM modules used by the SDK. Returns once they're ready for
/// hot-path use. Safe to call before `Wallet.create`.
export async function preloadWasm(opts: PreloadOpts = {}): Promise<void> {
    const tasks: Promise<unknown>[] = [WasmJubjub.build()];
    if (opts.prover !== false) {
        const { WasmProver } = await import("./wallet/wasm-prover.js");
        tasks.push(WasmProver.preload());
    }
    await Promise.all(tasks);
}
