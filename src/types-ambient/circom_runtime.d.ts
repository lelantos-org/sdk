// Ambient types for `circom_runtime`, which ships as untyped JavaScript.
//
// SCOPE: exactly what `prover/wasm-prover.ts` calls. See the note in
// `snarkjs.d.ts` — these declarations are unverified assertions, so the
// smaller the surface, the fewer unchecked claims.
//
// `calculateWitness` was previously declared and never called.

declare module "circom_runtime" {
    export interface WitnessCalculator {
        calculateWTNSBin(
            input: Record<string, unknown>,
            sanityCheck?: number,
        ): Promise<Uint8Array>;
    }

    export function WitnessCalculatorBuilder(
        wasmBuffer: ArrayBuffer | Uint8Array,
        options?: unknown,
    ): Promise<WitnessCalculator>;
}
