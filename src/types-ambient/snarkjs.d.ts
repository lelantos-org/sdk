// Ambient types for `snarkjs`, which ships as untyped JavaScript.
//
// Scope: exactly the calls `prover/snarkjs.ts` makes. These declarations are
// unverified against the real package, so an upstream signature change
// compiles clean and fails at runtime. Keep the surface minimal.

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
            // fastfile: string path/URL or in-memory Uint8Array.
            wasmFile: string | Uint8Array,
            zkeyFile: string | Uint8Array,
        ): Promise<FullProveResult>;
        verify(vkey: object, publicSignals: string[], proof: Groth16Proof): Promise<boolean>;
    };
}
