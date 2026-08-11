// Ambient types for `circom_runtime`, which ships as untyped JavaScript.
//
// Scope: exactly what `prover/wasm-prover.ts` calls. As with `snarkjs.d.ts`,
// these declarations are unverified assertions; keep the surface minimal.

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
