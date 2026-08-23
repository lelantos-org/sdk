// WASM module loading for Baby-Jubjub.
//
// Isolates bundler handling from the curve arithmetic. The boilerplate is
// `wasm/module-loader.ts`, shared with `../poseidon-wasm/loader.ts`; the
// Node/browser/injected branch under it is `wasm/loader.ts`.

import type { WasmLoaderOverride, WasmModuleBase } from "../../wasm/loader.js";
import { createModuleLoader } from "../../wasm/module-loader.js";

export interface JubWasmMod extends WasmModuleBase {
    add_point(a: Uint8Array, b: Uint8Array): Uint8Array;
    base8(): Uint8Array;
    hash_to_asset_gen(asset_id_le: Uint8Array): Uint8Array;
    in_subgroup(p: Uint8Array): boolean;
    mul_point_escalar(p: Uint8Array, scalar_le: Uint8Array): Uint8Array;
    pack_point(p: Uint8Array): Uint8Array;
    sub_order_le(): Uint8Array;
    try_decrypt_note(
        ivk_le: Uint8Array,
        epk_packed: Uint8Array,
        ciphertext: Uint8Array,
    ): Uint8Array | undefined;
    unpack_point(buf: Uint8Array): Uint8Array | undefined;
}

/**
 * Override for bundlers that rewrite `new URL(..., import.meta.url)` to a
 * runtime-invalid location. Call before `WasmJubjub.build()`.
 *
 * @internal
 */
export type JubjubWasmLoader = WasmLoaderOverride<JubWasmMod>;

// The import thunk and both URLs stay here, not in the shared factory: they
// resolve against *this* file. See the bundler contract in `wasm/module-loader.ts`.
const loader = createModuleLoader<JubWasmMod>({
    owner: "WasmJubjub",
    importModule: () => import("#wasm/jubjub"),
    pkgJsUrl: new URL("../../../wasm/jubjub/pkg/jubjub_wasm.js", import.meta.url),
    pkgWasmUrl: new URL("../../../wasm/jubjub/pkg/jubjub_wasm_bg.wasm", import.meta.url),
});

/** Call once at app boot, before `WasmJubjub.build()`. */
export function configureJubjubWasm(override: JubjubWasmLoader): void {
    loader.configure(override);
}

export function ensureInit(): Promise<void> {
    return loader.ensureInit();
}

/** The loaded module. Throws if `WasmJubjub.build()` has not run. */
export function w(): JubWasmMod {
    return loader.w();
}
