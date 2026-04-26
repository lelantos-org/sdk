// WASM module loading for Baby-Jubjub.
//
// Isolates the bundler handling (variable specifiers, `@vite-ignore`, the
// Node-only `node:url` hop) from the curve arithmetic.

import {
    createWasmLoader,
    type WasmLoaderOverride,
    type WasmModuleBase,
} from "../../wasm/loader.js";

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

const PKG_JS_URL = new URL("../../../wasm/jubjub/pkg/jubjub_wasm.js", import.meta.url);
const PKG_WASM_URL = new URL("../../../wasm/jubjub/pkg/jubjub_wasm_bg.wasm", import.meta.url);

// Specifiers held in variables (+ `@vite-ignore` below) so Vite skips static
// resolution. `node:url` is Node-only; `#wasm/jubjub` requires either a Node
// runtime or an injected loader.
const NODE_URL = "node:url";
const WASM_JUBJUB_SUBPATH = "#wasm/jubjub";

const loader = createWasmLoader<JubWasmMod>({
    name: "jubjub",
    defaultImport: () => import(/* @vite-ignore */ WASM_JUBJUB_SUBPATH) as Promise<JubWasmMod>,
    nodeJsUrl: async () => PKG_JS_URL.href,
    nodeWasmPath: async () => {
        const { fileURLToPath } = await import(/* @vite-ignore */ NODE_URL);
        return fileURLToPath(PKG_WASM_URL);
    },
});

/** Call once at app boot, before `WasmJubjub.build()`. */
export function configureJubjubWasm(override: JubjubWasmLoader): void {
    loader.configure(override);
}

let jubWasm: JubWasmMod | null = null;

export async function ensureInit(): Promise<void> {
    jubWasm = await loader.load();
}

/** The loaded module. Throws if `WasmJubjub.build()` has not run. */
export function w(): JubWasmMod {
    if (!jubWasm) throw new Error("WasmJubjub not initialized; call WasmJubjub.build() first");
    return jubWasm;
}
