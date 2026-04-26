// Test-only helpers shared by the `*-wasm.test.ts` parity suites.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe } from "vitest";
import type { WasmJubjub } from "./jubjub-wasm/index.js";

const PKG_PATH = resolve(__dirname, "../../wasm/jubjub/pkg/jubjub_wasm_bg.wasm");
export const HAS_WASM = existsSync(PKG_PATH);

/** `describe.skip` when the wasm artifact has not been built. */
export const wasmDescribe = HAS_WASM ? describe : describe.skip;

/** Lazily construct a `WasmJubjub`. Dynamic import keeps skipped suites from loading the module. */
export async function loadWasmJubjub(): Promise<WasmJubjub> {
    const mod = await import("./jubjub-wasm/index.js");
    return mod.WasmJubjub.build();
}
