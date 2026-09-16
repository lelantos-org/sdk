// Poseidon over BN254, circomlib-compatible.
//
// Two backends, split by arity:
//
//   arity 5  -> wasm (`sdk/wasm/poseidon`): `Poseidon(TAG_MERKLE, ..)` is ~349,525 calls in a
//               full tree build and costs 235 µs each in JS. Measured 2.7x faster.
//   others   -> `poseidon-lite`, because they run a handful of times per
//               operation and each extra arity in the wasm module costs
//               ~200 KB: light-poseidon emits its round constants as code, one
//               construction per width. See `wasm/poseidon/src/lib.rs`.
//
// Both are pinned to the same digests by `tests/vectors/poseidon.json`, which
// the Rust backend asserts too.
//
// Per-arity subpaths, not the `poseidon-lite` barrel. The barrel is CommonJS and re-exports all
// 16 arities through `Object.defineProperty` getters, which bundlers cannot analyse statically, so
// importing it pulls every round-constant table (~604 KB minified). `bundle-budget.mjs` enforces
// this.
import { poseidon1 } from "poseidon-lite/poseidon1";
import { poseidon2 } from "poseidon-lite/poseidon2";
import { poseidon3 } from "poseidon-lite/poseidon3";
import { poseidon4 } from "poseidon-lite/poseidon4";
import { poseidon5 } from "poseidon-lite/poseidon5";
import { poseidon6 } from "poseidon-lite/poseidon6";
import { FIELD_BYTES, fromBeBytes, writeBeInto } from "../core/bytes.js";
import { assertField, type Field } from "../core/field.js";
import { errMessage } from "../errors/base.js";
import { InvalidArgumentError } from "../errors/config.js";
import { getLogger } from "../log/logger.js";
import { ensureInit, type PoseidonWasmMod, w } from "./poseidon-wasm/loader.js";

export { configurePoseidonWasm, type PoseidonWasmLoader } from "./poseidon-wasm/loader.js";

export type { Field };

const log = getLogger("lelantos:crypto:poseidon");

/** Which implementation served a hash. Exposed for logging and assertions. */
export type PoseidonBackend = "wasm" | "js";

/** The wasm-backed arity. Everything else stays on the JS tables. */
const WASM_ARITY = 5;

// JS backend for every arity and fallback for `WASM_ARITY`. Parity with circomlibjs
// `buildPoseidon` (BN254, iden3 constants) is verified by `poseidon.test.ts`.
//
// Arities 1-6 only. The protocol hashes at 2 (key derivation), 3 (rho, subscription token),
// 4 (commitment, nullifier, FMD expand), 5 (Merkle node) and 6 (FMD bit); 1 serves the circomlib
// anchor in `poseidon-vectors.test.ts`. Each arity adds a round-constant table to every consumer
// bundle, so unused widths are excluded.
const JS_TABLE: Record<number, (xs: Field[]) => Field> = {
    1: poseidon1 as (xs: Field[]) => Field,
    2: poseidon2 as (xs: Field[]) => Field,
    3: poseidon3 as (xs: Field[]) => Field,
    4: poseidon4 as (xs: Field[]) => Field,
    5: poseidon5 as (xs: Field[]) => Field,
    6: poseidon6 as (xs: Field[]) => Field,
};

/**
 * Bind arity-5 hashing to the wasm module.
 *
 * The scratch buffer is per-instance and reused across calls, since a full tree build is ~350K
 * hashes. Reuse is safe because `hash` is synchronous; an async variant would need its own buffer.
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
     * Which implementation arity-5 hashes use. `"js"` means the wasm module did not load and each
     * hash is ~2.5x slower; relevant for benchmarks and slow syncs.
     */
    readonly backend: PoseidonBackend;

    /**
     * Inputs must already be canonical field elements, i.e. in `[0, r)`.
     *
     * poseidon-lite reduces mod `r` internally, so `x` and `x + r` hash identically. Every
     * domain-separated construction in the SDK (nullifiers, note commitments, rho, the key ladder,
     * merkle nodes) routes through here, so without this check distinct decoded records or merkle
     * leaves could collide. The decoders that feed it (`notes/codec.ts`, `keys/address.ts`) read
     * raw 32-byte slices and can produce unreduced values.
     *
     * The wasm backend also rejects unreduced input; checking here keeps the error identical across
     * backends. The cost is one comparison per input.
     *
     * A bound property rather than a prototype method, so the class stays structurally
     * `{ backend, hash }` and the arity table is captured per instance instead of branching on the
     * backend per hash.
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
            if (!fn) {
                throw new InvalidArgumentError(`Poseidon arity ${xs.length} not supported (1..6)`, {
                    argument: "inputs",
                });
            }
            for (const [i, x] of xs.entries()) assertField(x, `Poseidon input ${i}`);
            return fn(xs);
        };
    }

    /**
     * Initialises the wasm backend.
     *
     * Failure is not fatal: the JS tables cover every arity, so the instance falls back to the
     * slower backend. The failure is logged, since a 2.5x slowdown otherwise surfaces only as a
     * slow cold sync.
     */
    static async build(): Promise<Poseidon> {
        try {
            await ensureInit();
            return new Poseidon("wasm", wasmHash5(w()));
        } catch (error) {
            log.warn("wasm unavailable; arity-5 hashing falls back to poseidon-lite", {
                error: errMessage(error),
            });
            return new Poseidon("js", poseidon5 as (xs: Field[]) => Field);
        }
    }
}
