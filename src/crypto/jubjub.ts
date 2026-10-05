// Baby-Jubjub types. Runtime implementation lives in `./jubjub-wasm/` (Rust/WASM).

import type { Field } from "./poseidon.js";

export type Point = [Field, Field];

/** Whether `a` and `b` are the same affine point. */
export function samePoint(a: readonly [Field, Field], b: readonly [Field, Field]): boolean {
    return a[0] === b[0] && a[1] === b[1];
}

export { Jubjub } from "./jubjub-wasm/index.js";
