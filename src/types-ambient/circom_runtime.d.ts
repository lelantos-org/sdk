// Ambient types for `circom_runtime`, which ships as untyped JavaScript.
//
// Scope: only what `prover/wasm-prover.ts` calls. As with `snarkjs.d.ts`, these
// declarations are not checked against the package; keep the surface minimal.

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
