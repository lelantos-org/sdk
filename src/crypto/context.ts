// Lazily-built, process-wide `Poseidon` + `Jubjub` pair.
//
// Both are stateless and their construction is idempotent and cached, so a
// single shared instance is safe. Threading them through public signatures
// forced every caller to know the backend exists and to build it before
// calling something as ordinary as "parse this address string".
//
// Callers that need explicit instances — worker bundles that construct their
// own, benchmarks comparing backends — still pass them: the explicit
// overloads take precedence and nothing here is on their path.

import { memoAsync } from "../core/async.js";
import type { Jubjub } from "./jubjub.js";
import { WasmJubjub } from "./jubjub-wasm/index.js";
import { Poseidon } from "./poseidon.js";

/** The primitives the off-circuit code paths need. */
export interface CryptoContext {
    P: Poseidon;
    J: Jubjub;
}

const context = memoAsync<CryptoContext>(async () => {
    const [P, J] = await Promise.all([Poseidon.build(), WasmJubjub.build()]);
    return { P, J };
});

/**
 * The shared context, built on first use.
 *
 * Concurrent callers await the same promise, so the WASM module is
 * instantiated once however many code paths race for it. Nothing is built at
 * import time: a bundle that never calls this never pays for it.
 *
 * A failed build is not cached — see {@link memoAsync}. A caller that races
 * ahead of `configureJubjubWasm`, or one transient import failure, would
 * otherwise brick the wallet for the lifetime of the process.
 */
export function cryptoContext(): Promise<CryptoContext> {
    return context.get();
}

/**
 * The shared context if already built, otherwise `undefined`.
 *
 * For callers that must not trigger a wasm load — a synchronous fast path that
 * falls back when the context is cold.
 */
export function cryptoContextIfReady(): CryptoContext | undefined {
    return context.peek();
}
