// Baby-Jubjub types. Runtime implementation lives in `./jubjub-wasm/` (Rust/WASM).

import type { Field } from "./poseidon.js";

export type Point = [Field, Field];

export { Jubjub } from "./jubjub-wasm/index.js";
