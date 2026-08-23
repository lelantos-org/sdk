// WASM module loading for Poseidon-5.
//
// Isolates bundler handling (variable specifiers, `@vite-ignore`, the
// Node-only `node:url` hop) from the hashing. Mirrors
// `../jubjub-wasm/loader.ts`; the shared machinery is `wasm/loader.ts`.

import {
    createWasmLoader,
    type WasmLoaderOverride,
    type WasmModuleBase,
} from "../../wasm/loader.js";

export interface PoseidonWasmMod extends WasmModuleBase {
    /** 5 x 32B big-endian in, 32B big-endian out. Throws on non-canonical input. */
    poseidon5(inputs_be: Uint8Array): Uint8Array;
}

/**
 * Override for bundlers that rewrite `new URL(..., import.meta.url)` to a
 * runtime-invalid location. Call before `Poseidon.build()`.
 *
 * @internal
 */
export type PoseidonWasmLoader = WasmLoaderOverride<PoseidonWasmMod>;

const PKG_JS_URL = new URL("../../../wasm/poseidon/pkg/poseidon_wasm.js", import.meta.url);
const PKG_WASM_URL = new URL("../../../wasm/poseidon/pkg/poseidon_wasm_bg.wasm", import.meta.url);

// Specifiers held in variables (+ `@vite-ignore` below) so Vite skips static
// resolution. `node:url` is Node-only; `#wasm/poseidon` requires either a Node
// runtime or an injected loader.
const NODE_URL = "node:url";
const WASM_POSEIDON_SUBPATH = "#wasm/poseidon";

const loader = createWasmLoader<PoseidonWasmMod>({
    name: "poseidon",
    defaultImport: () =>
        import(/* @vite-ignore */ WASM_POSEIDON_SUBPATH) as Promise<PoseidonWasmMod>,
    nodeJsUrl: async () => PKG_JS_URL.href,
    nodeWasmPath: async () => {
        const { fileURLToPath } = await import(/* @vite-ignore */ NODE_URL);
        return fileURLToPath(PKG_WASM_URL);
    },
});

/** Call once at app boot, before `Poseidon.build()`. */
export function configurePoseidonWasm(override: PoseidonWasmLoader): void {
    loader.configure(override);
}

let mod: PoseidonWasmMod | null = null;

export async function ensureInit(): Promise<void> {
    mod = await loader.load();
}

/** The loaded module. Throws if `Poseidon.build()` has not run. */
export function w(): PoseidonWasmMod {
    if (!mod) throw new Error("Poseidon wasm not initialized; call Poseidon.build() first");
    return mod;
}
