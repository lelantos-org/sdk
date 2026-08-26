// Poseidon over BN254, circomlib-compatible.
//
// Two backends, split by arity:
//
//   arity 5  -> wasm (`sdk/wasm/poseidon`), because `Poseidon(TAG_MERKLE, ..)`
//               is ~349,525 calls in a full tree build and the JS one costs
//               235 us each. Measured 2.7x faster.
//   others   -> `poseidon-lite`, because they run a handful of times per
//               operation and each extra arity in the wasm module costs
//               ~200 KB: light-poseidon emits its round constants as code, one
//               construction per width. See `wasm/poseidon/src/lib.rs`.
//
// Both are pinned to the same digests by `tests/vectors/poseidon.json`, which
// the Rust backend asserts too.
//
// Per-arity subpaths, not the `poseidon-lite` barrel. The barrel is CommonJS
// and re-exports all 16 arities through `Object.defineProperty` getters, which
// no bundler can analyse statically — importing it pulls every round-constant
// table (~604 KB minified). The subpaths pull only the arities named here.
// `bundle-budget.mjs` guards the difference.
import { poseidon1 } from "poseidon-lite/poseidon1";
import { poseidon2 } from "poseidon-lite/poseidon2";
import { poseidon3 } from "poseidon-lite/poseidon3";
import { poseidon4 } from "poseidon-lite/poseidon4";
import { poseidon5 } from "poseidon-lite/poseidon5";
import { poseidon6 } from "poseidon-lite/poseidon6";
import { poseidon7 } from "poseidon-lite/poseidon7";
import { poseidon8 } from "poseidon-lite/poseidon8";

import { FIELD_BYTES, fromBeBytes, writeBeInto } from "../core/bytes.js";
import { assertField } from "../core/field.js";
import { getLogger } from "../log/logger.js";
import { ensureInit, type PoseidonWasmMod, w } from "./poseidon-wasm/loader.js";

export { configurePoseidonWasm, type PoseidonWasmLoader } from "./poseidon-wasm/loader.js";

export type Field = bigint;

const log = getLogger("lelantos:crypto:poseidon");

/** Which implementation served a hash. Exposed for logging and assertions. */
export type PoseidonBackend = "wasm" | "js";

/** The wasm-backed arity. Everything else stays on the JS tables. */
const WASM_ARITY = 5;

// poseidon-lite exports a fixed-arity function per input width. Parity with
// circomlibjs `buildPoseidon` (BN254, iden3 constants) is verified by
// `poseidon.test.ts`. Arity ceiling 8 covers all in-tree callers.
//
// The JS backend for every arity, and the fallback for `WASM_ARITY`.
const JS_TABLE: Record<number, (xs: Field[]) => Field> = {
    1: poseidon1 as (xs: Field[]) => Field,
    2: poseidon2 as (xs: Field[]) => Field,
    3: poseidon3 as (xs: Field[]) => Field,
    4: poseidon4 as (xs: Field[]) => Field,
    5: poseidon5 as (xs: Field[]) => Field,
    6: poseidon6 as (xs: Field[]) => Field,
    7: poseidon7 as (xs: Field[]) => Field,
    8: poseidon8 as (xs: Field[]) => Field,
};

/**
 * Bind arity-5 hashing to the wasm module.
 *
 * The scratch buffer is per-instance and reused across calls: a full tree
 * build is ~350K hashes, and allocating 160 bytes each time would eat the
 * saving. Safe to reuse because `hash` is synchronous and has no `await`, so
 * one call completes before another can enter — a future async variant must
 * allocate its own.
 */
function wasmHash5(mod: PoseidonWasmMod): (xs: Field[]) => Field {
    const scratch = new Uint8Array(WASM_ARITY * FIELD_BYTES);
    return (xs) => {
        for (const [i, x] of xs.entries()) writeBeInto(scratch, i * FIELD_BYTES, x);
        return fromBeBytes(mod.poseidon5(scratch));
    };
}

export class Poseidon {
    /**
     * Which implementation arity-5 hashes use. `"js"` means the wasm module
     * did not load and every hash is ~2.5x slower — worth asserting in
     * benchmarks and worth checking first when a sync is unexpectedly slow.
     */
    readonly backend: PoseidonBackend;

    /**
     * Inputs must already be canonical field elements, i.e. in `[0, r)`.
     *
     * poseidon-lite reduces mod `r` internally, so `x` and `x + r` hash
     * identically. Every domain-separated construction in the SDK routes
     * through here — nullifiers, note commitments, rho, the key ladder, merkle
     * nodes — so without this check two distinct decoded records or two
     * distinct merkle leaves can be made to collide by construction. Both
     * decoders that feed it (`notes/codec.ts`, `keys/address.ts`) read raw
     * 32-byte slices and can produce unreduced values.
     *
     * The wasm backend rejects unreduced input rather than reducing it, so the
     * two agree — but the check stays here to keep the error identical
     * whichever backend is live.
     *
     * One comparison per input against a full permutation: not measurable.
     *
     * A bound property rather than a prototype method, so the class stays
     * structurally `{ backend, hash }` and the arity table can be captured per
     * instance — the backend is a property of the instance, not of the call,
     * so it must not be branched on per hash.
     */
    readonly hash: (xs: Field[]) => Field;

    private constructor(backend: PoseidonBackend, hash5: (xs: Field[]) => Field) {
        this.backend = backend;
        const table: Record<number, (xs: Field[]) => Field> = {
            ...JS_TABLE,
            [WASM_ARITY]: hash5,
        };
        this.hash = (xs) => {
            const fn = table[xs.length];
            if (!fn) throw new Error(`Poseidon arity ${xs.length} not supported (1..8)`);
            for (const [i, x] of xs.entries()) assertField(x, `Poseidon input ${i}`);
            return fn(xs);
        };
    }

    /**
     * Initialises the wasm backend.
     *
     * A failure here is not fatal: the JS tables cover every arity, so an
     * environment that cannot load wasm degrades to the slower backend rather
     * than to a broken wallet. It is logged rather than swallowed, since a
     * silent 2.5x loss surfaces only as a slow cold sync.
     */
    static async build(): Promise<Poseidon> {
        try {
            await ensureInit();
            return new Poseidon("wasm", wasmHash5(w()));
        } catch (error) {
            log.warn("wasm unavailable; arity-5 hashing falls back to poseidon-lite", {
                error: error instanceof Error ? error.message : String(error),
            });
            return new Poseidon("js", poseidon5 as (xs: Field[]) => Field);
        }
    }
}
