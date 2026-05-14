// Minimal type surface for circom_runtime (ships without TS types).

declare module "circom_runtime" {
    export interface WitnessCalculator {
        calculateWTNSBin(
            input: Record<string, unknown>,
            sanityCheck?: number,
        ): Promise<Uint8Array>;
        calculateWitness(
            input: Record<string, unknown>,
            sanityCheck?: number,
        ): Promise<bigint[]>;
    }

    export function WitnessCalculatorBuilder(
        wasmBuffer: ArrayBuffer | Uint8Array,
        options?: unknown,
    ): Promise<WitnessCalculator>;
}
