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

import { FIELD_BYTES } from "../core/bytes.js";
import { assertField } from "../core/field.js";
import { getLogger } from "../log/logger.js";
import { ensureInit, w } from "./poseidon-wasm/loader.js";

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
const TABLE: Record<number, (xs: Field[]) => bigint> = {
    1: poseidon1 as (xs: Field[]) => bigint,
    2: poseidon2 as (xs: Field[]) => bigint,
    3: poseidon3 as (xs: Field[]) => bigint,
    4: poseidon4 as (xs: Field[]) => bigint,
    5: poseidon5 as (xs: Field[]) => bigint,
    6: poseidon6 as (xs: Field[]) => bigint,
    7: poseidon7 as (xs: Field[]) => bigint,
    8: poseidon8 as (xs: Field[]) => bigint,
};

/**
 * Scratch for the wasm boundary, reused across calls — a full tree build is
 * ~350K hashes and allocating per call would dominate the saving.
 *
 * Safe to share despite being module state: `hash` is synchronous and contains
 * no `await`, so it runs to completion before any other caller can enter. A
 * future async variant must not reuse this.
 */
const wasmInput = new Uint8Array(WASM_ARITY * FIELD_BYTES);

// Big-endian, matching `poseidon_hash`'s wire contract. `core/bytes.ts` is
// little-endian (on-chain serialisation) and allocates per call, so neither of
// its helpers fits here.
function writeBe(dst: Uint8Array, offset: number, x: Field): void {
    for (let i = FIELD_BYTES - 1; i >= 0; i--) {
        dst[offset + i] = Number(x & 0xffn);
        x >>= 8n;
    }
}

function readBe(src: Uint8Array): Field {
    let out = 0n;
    for (const b of src) out = (out << 8n) | BigInt(b);
    return out;
}

export class Poseidon {
    /**
     * Which implementation arity-5 hashes use. `"js"` means the wasm module
     * did not load and every hash is ~2.5x slower — worth asserting in
     * benchmarks and worth checking first when a sync is unexpectedly slow.
     */
    readonly backend: PoseidonBackend;

    private constructor(backend: PoseidonBackend) {
        this.backend = backend;
    }

    /**
     * Initialises the wasm backend. Already `async` before it did anything, so
     * no caller changes.
     *
     * A failure here is not fatal: the JS tables cover every arity, so an
     * environment that cannot load wasm degrades to the slower backend rather
     * than to a broken wallet. It is logged rather than swallowed — silently
     * losing 2.5x is the kind of regression nobody notices until a cold sync
     * takes a minute.
     */
    static async build(): Promise<Poseidon> {
        try {
            await ensureInit();
            return new Poseidon("wasm");
        } catch (error) {
            log.warn("wasm unavailable; arity-5 hashing falls back to poseidon-lite", {
                error: error instanceof Error ? error.message : String(error),
            });
            return new Poseidon("js");
        }
    }

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
     */
    hash(xs: Field[]): Field {
        const fn = TABLE[xs.length];
        if (!fn) throw new Error(`Poseidon arity ${xs.length} not supported (1..8)`);
        for (const [i, x] of xs.entries()) assertField(x, `Poseidon input ${i}`);

        if (this.backend === "wasm" && xs.length === WASM_ARITY) {
            for (const [i, x] of xs.entries()) writeBe(wasmInput, i * FIELD_BYTES, x);
            return readBe(w().poseidon5(wasmInput));
        }
        return fn(xs);
    }
}
