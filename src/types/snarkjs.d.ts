// Minimal type surface for snarkjs (ships without TS types).
// Covers only what this SDK calls. Extend as needed.

declare module "snarkjs" {
    export interface Groth16Proof {
        pi_a: string[];
        pi_b: string[][];
        pi_c: string[];
        protocol: "groth16";
        curve: "bn128";
    }

    export interface FullProveResult {
        proof: Groth16Proof;
        publicSignals: string[];
    }

    export const groth16: {
        fullProve(
            input: Record<string, unknown>,
            wasmPath: string,
            zkeyPath: string,
        ): Promise<FullProveResult>;
        verify(
            vkey: object,
            publicSignals: string[],
            proof: Groth16Proof,
        ): Promise<boolean>;
        exportSolidityCallData(
            proof: Groth16Proof,
            publicSignals: string[],
        ): Promise<string>;
        prove(
            zkeyPath: string,
            wtnsPath: string | Uint8Array,
        ): Promise<FullProveResult>;
    };

    export const wtns: {
        calculate(
            input: Record<string, unknown>,
            wasmPath: string,
            wtnsPath: string,
        ): Promise<void>;
    };

    export const zKey: {
        exportVerificationKey(zkeyPath: string): Promise<object>;
    };
}
