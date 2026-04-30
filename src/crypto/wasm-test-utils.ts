// Test-only helpers shared by the `*-wasm.test.ts` parity suites.
// Centralizes "skip when wasm pkg absent" boilerplate so test files only
// declare what they actually verify.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe } from "vitest";
import type { WasmJubjub } from "./jubjub-wasm";

const PKG_PATH = resolve(__dirname, "../../wasm/jubjub/pkg/jubjub_wasm_bg.wasm");
export const HAS_WASM = existsSync(PKG_PATH);

/// Use in place of `describe`. Becomes `describe.skip` when the wasm
/// artifact has not been built (e.g. fresh checkout, no `just build`).
export const wasmDescribe = HAS_WASM ? describe : describe.skip;

/// Lazily construct a `WasmJubjub` instance. Imported dynamically so the
/// module isn't loaded when wasm is missing (skipped suites stay clean).
export async function loadWasmJubjub(): Promise<WasmJubjub> {
    const mod = await import("./jubjub-wasm");
    return mod.WasmJubjub.build();
}
