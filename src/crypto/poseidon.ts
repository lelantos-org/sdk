// Poseidon over BN254, circomlib-compatible, at arities 1 to 6.
//
// Two backends:
//
//   wasm (`sdk/wasm/poseidon`)  every arity. `Poseidon(TAG_MERKLE, ..)` at arity 5 dominates a
//                               tree build; the other arities dominate building a spend.
//   `poseidon-lite`             the fallback, loaded only when the wasm module fails to
//                               initialise, so its round-constant tables are not in a consumer
//                               bundle's eager graph.
//
// Both are pinned to the same digests by `tests/vectors/poseidon.json`, which the Rust backend
// asserts too.
//
// The fallback imports per-arity subpaths, not the `poseidon-lite` barrel: the barrel is CommonJS
// and re-exports every arity through `Object.defineProperty` getters, which bundlers cannot
// analyse statically, so importing it pulls every round-constant table, used or not.
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

type Hasher = (xs: Field[]) => Field;

// The protocol hashes at 2 (key derivation), 3 (note commitment, rho, subscription token),
// 4 (note inner, nullifier, FMD expand), 5 (Merkle node, coefficient digest) and 6 (FMD bit);
// 1 serves the circomlib anchor in `poseidon-vectors.test.ts`.
const MIN_ARITY = 1;
const MAX_ARITY = 6;

/**
 * Bind hashing to the wasm module. One scratch buffer per arity, per instance and reused across
 * calls, which is safe because `hash` is synchronous.
 */
function wasmHasher(mod: PoseidonWasmMod): Hasher {
    const scratch = Array.from(
        { length: MAX_ARITY + 1 },
        (_, arity) => new Uint8Array(arity * FIELD_BYTES),
    );
    return (xs) => {
        const buf = scratch[xs.length] as Uint8Array;
        for (const [i, x] of xs.entries()) writeBeInto(buf, i * FIELD_BYTES, x);
        return fromBeBytes(mod.poseidon(buf));
    };
}

/**
 * The `poseidon-lite` tables, loaded on demand. Parity with circomlibjs `buildPoseidon` (BN254,
 * iden3 constants) is verified by `poseidon.test.ts`.
 */
async function jsHasher(): Promise<Hasher> {
    const [m1, m2, m3, m4, m5, m6] = await Promise.all([
        import("poseidon-lite/poseidon1"),
        import("poseidon-lite/poseidon2"),
        import("poseidon-lite/poseidon3"),
        import("poseidon-lite/poseidon4"),
        import("poseidon-lite/poseidon5"),
        import("poseidon-lite/poseidon6"),
    ]);
    // Indexed by `arity - MIN_ARITY`.
    const table: Hasher[] = [
        m1.poseidon1,
        m2.poseidon2,
        m3.poseidon3,
        m4.poseidon4,
        m5.poseidon5,
        m6.poseidon6,
    ];
    return (xs) => (table[xs.length - MIN_ARITY] as Hasher)(xs);
}

export class Poseidon {
    /** Which implementation serves hashes. `"js"` means the wasm module did not load. */
    readonly backend: PoseidonBackend;

    /**
     * Inputs must already be canonical field elements, i.e. in `[0, r)`.
     *
     * poseidon-lite reduces mod `r` internally, so `x` and `x + r` hash identically. Every
     * domain-separated construction in the SDK routes through here, so without this check distinct
     * decoded records or merkle leaves could collide: the decoders that feed it (`notes/codec.ts`,
     * `keys/address.ts`) read raw 32-byte slices and can produce unreduced values. The wasm backend
     * also rejects unreduced input; checking here keeps the error identical across backends.
     *
     * A bound property rather than a prototype method, so the class stays structurally
     * `{ backend, hash }` and the backend is captured per instance instead of branched on per
     * hash.
     */
    readonly hash: (xs: Field[]) => Field;

    private constructor(backend: PoseidonBackend, hasher: Hasher) {
        this.backend = backend;
        this.hash = (xs) => {
            if (xs.length < MIN_ARITY || xs.length > MAX_ARITY) {
                throw new InvalidArgumentError(
                    `Poseidon arity ${xs.length} not supported (${MIN_ARITY}..${MAX_ARITY})`,
                    { argument: "inputs" },
                );
            }
            for (const [i, x] of xs.entries()) assertField(x, `Poseidon input ${i}`);
            return hasher(xs);
        };
    }

    /**
     * Initialises the wasm backend. Failure is not fatal: the instance loads the JS tables
     * instead and logs a warning, since the slowdown has no other symptom.
     */
    static async build(): Promise<Poseidon> {
        try {
            await ensureInit();
            return new Poseidon("wasm", wasmHasher(w()));
        } catch (error) {
            log.warn("wasm unavailable; hashing falls back to poseidon-lite", {
                error: errMessage(error),
            });
            return new Poseidon("js", await jsHasher());
        }
    }
}
