// Ambient types for `snarkjs`, which ships as untyped JavaScript.
//
// SCOPE: exactly the calls `prover/snarkjs.ts` makes, and nothing else.
//
// Nothing verifies these against the real package — they are a hand-written
// assertion that `tsc` then trusts, so a signature change upstream compiles
// clean and fails at runtime. That is inherent to ambient declarations, and
// it is the reason to keep the surface as small as the code allows: every
// member declared here is a claim someone has to keep true, and members the
// SDK never calls are claims nobody will ever check.
//
// Previously this also declared `exportSolidityCallData`, `groth16.prove`,
// `wtns.calculate` and `zKey.exportVerificationKey` — none of which the SDK
// calls.

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
