// Test-only helpers for suites that need the built jubjub wasm.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe } from "vitest";
import type { Jubjub } from "../crypto/jubjub-wasm/index.js";

const PKG_PATH = resolve(__dirname, "../../wasm/jubjub/pkg/jubjub_wasm_bg.wasm");
export const HAS_WASM = existsSync(PKG_PATH);

/** `describe.skip` when the wasm artifact has not been built. */
export const wasmDescribe = HAS_WASM ? describe : describe.skip;

/** Lazily construct a `Jubjub`. Dynamic import keeps skipped suites from loading the module. */
export async function loadJubjub(): Promise<Jubjub> {
    const mod = await import("../crypto/jubjub-wasm/index.js");
    return mod.Jubjub.build();
}
