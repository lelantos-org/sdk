// Eager WASM warmup. Lets apps surface a loading spinner instead of paying
// first-decrypt latency at the worst moment (the user's first `wallet.sync()`).
//
// Idempotent — both jubjub and prover modules cache themselves after first
// build, so calling `preloadWasm()` multiple times is free.

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
