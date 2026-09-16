// Lazily-built, process-wide `Poseidon` + `Jubjub` pair.
//
// Both are stateless and their construction is idempotent and cached, so a single shared
// instance is safe. This keeps backend construction out of public signatures.
//
// Callers that need explicit instances (worker bundles, benchmarks comparing backends) pass them
// through the explicit overloads, which bypass this module.

import { memoAsync } from "../core/async.js";
import { Jubjub } from "./jubjub-wasm/index.js";
import { Poseidon } from "./poseidon.js";

/** The primitives the off-circuit code paths need. */
export interface CryptoContext {
    P: Poseidon;
    J: Jubjub;
}

const context = memoAsync<CryptoContext>(async () => {
    const [P, J] = await Promise.all([Poseidon.build(), Jubjub.build()]);
    return { P, J };
});

/**
 * The shared context, built on first use.
 *
 * Concurrent callers await the same promise, so the WASM module is instantiated once. Nothing is
 * built at import time.
 *
 * A failed build is not cached (see `memoAsync` in `core/async.ts`), so a call that races ahead of
 * `configureJubjubWasm`, or a transient import failure, does not disable the wallet for the
 * lifetime of the process.
 */
export function cryptoContext(): Promise<CryptoContext> {
    return context.get();
}

/**
 * The shared context if already built, otherwise `undefined`.
 *
 * For callers that must not trigger a wasm load, such as a synchronous fast path.
 */
export function cryptoContextIfReady(): CryptoContext | undefined {
    return context.peek();
}
