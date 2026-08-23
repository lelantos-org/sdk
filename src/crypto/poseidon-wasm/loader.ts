// WASM module loading for Poseidon-5.
//
// Isolates bundler handling from the hashing. The boilerplate is
// `wasm/module-loader.ts`, shared with `../jubjub-wasm/loader.ts`; the
// Node/browser/injected branch under it is `wasm/loader.ts`.

import type { WasmLoaderOverride, WasmModuleBase } from "../../wasm/loader.js";
import { createModuleLoader } from "../../wasm/module-loader.js";

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

// `new URL(..., import.meta.url)` resolves against *this* file, so it stays
// here rather than moving into the shared factory.
const loader = createModuleLoader<PoseidonWasmMod>({
    owner: "Poseidon",
    subpath: "#wasm/poseidon",
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
