// Baby-Jubjub types + shared constants. Runtime impl lives in
// `./jubjub-wasm.ts` (Rust/WASM). `Jubjub` is exported as a type alias for
// the WASM class so the rest of the codebase keeps a single nominal name.

import type { Field } from "./poseidon.js";

export type Point = [Field, Field];

/** @internal */
/// Fixed independent generator for value-commitment blinding:
///   cv = value · gen + rcv · H
/// Must match `circuits/src/lib/value_commit.circom` byte-for-byte.
export const H_BASE: Point = [
    5802099305472655231388284418920769829666717045250560929368476121199858275951n,
    5980429700218124965372158798884772646841287887664001482443826541541529227896n,
];

export { WasmJubjub as Jubjub } from "./jubjub-wasm.js";
