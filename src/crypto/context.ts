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

import type { Jubjub } from "./jubjub.js";
import { WasmJubjub } from "./jubjub-wasm/index.js";
import { Poseidon } from "./poseidon.js";

/** The primitives the off-circuit code paths need. */
export interface CryptoContext {
    P: Poseidon;
    J: Jubjub;
}

let pending: Promise<CryptoContext> | undefined;
let ready: CryptoContext | undefined;

/**
 * The shared context, built on first use.
 *
 * Concurrent callers await the same promise, so the WASM module is
 * instantiated once however many code paths race for it. Nothing is built at
 * import time: a bundle that never calls this never pays for it.
 */
export function cryptoContext(): Promise<CryptoContext> {
    if (!pending) {
        pending = Promise.all([Poseidon.build(), WasmJubjub.build()]).then(([P, J]) => {
            ready = { P, J };
            return ready;
        });
    }
    return pending;
}

/** The shared context if already built, otherwise `undefined`. */
export function cryptoContextIfReady(): CryptoContext | undefined {
    return ready;
}
