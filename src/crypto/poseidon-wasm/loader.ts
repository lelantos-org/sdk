// WASM module loading for Poseidon-5, kept apart from the hashing. Built on the factory in
// `runtime/wasm/module-loader.ts`, shared with `../jubjub-wasm/loader.ts`.

import type { WasmLoaderOverride, WasmModuleBase } from "../../runtime/wasm/loader.js";
import { createModuleLoader } from "../../runtime/wasm/module-loader.js";

export interface PoseidonWasmMod extends WasmModuleBase {
    /** 5 x 32B big-endian in, 32B big-endian out. Throws on non-canonical input. */
    poseidon5(inputs_be: Uint8Array): Uint8Array;
}

/**
 * Override for bundlers that rewrite `new URL(..., import.meta.url)` to a runtime-invalid
 * location.
 *
 * @internal
 */
export type PoseidonWasmLoader = WasmLoaderOverride<PoseidonWasmMod>;

// The import thunk and both URLs resolve against this file, so they cannot move into the shared
// factory. See the bundler contract in `runtime/wasm/module-loader.ts`.
const loader = createModuleLoader<PoseidonWasmMod>({
    owner: "Poseidon",
    importModule: () => import("#wasm/poseidon"),
    pkgJsUrl: new URL("../../../wasm/poseidon/pkg/poseidon_wasm.js", import.meta.url),
    pkgWasmUrl: new URL("../../../wasm/poseidon/pkg/poseidon_wasm_bg.wasm", import.meta.url),
});

/** Call once at app boot, before `Poseidon.build()`. */
export function configurePoseidonWasm(override: PoseidonWasmLoader): void {
    loader.configure(override);
}

export function ensureInit(): Promise<void> {
    return loader.ensureInit();
}

/** The loaded module. Throws if `Poseidon.build()` has not run. */
export function w(): PoseidonWasmMod {
    return loader.w();
}
