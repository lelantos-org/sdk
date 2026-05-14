// Errors raised by the proving pipeline.

import { WalletError } from "./base.js";

/// Groth16 proof generation failure. `cause` carries the underlying error.
export class ProverError extends WalletError {
    constructor(message: string, opts?: { cause?: unknown }) {
        super("PROVER_FAILED", message, opts);
        this.name = "ProverError";
    }
}

/// No prover artifacts available. Browser callers hit this whenever
/// neither `proverArtifacts` nor `proverArtifactsCdn` is set, because the
/// companion package has no public CDN fallback.
export class ProverArtifactsMissingError extends WalletError {
    readonly tried: string[];
    constructor(tried: string[]) {
        super(
            "PROVER_ARTIFACTS_MISSING",
            `prover artifacts not found. Tried: ${tried.join(", ")}. ` +
                `Fixes (any one): pass \`proverArtifacts: { circuit, zkey }\` to ` +
                `Wallet.connect (browser must do this — no built-in CDN); install ` +
                `\`@lelantos-org/circuits\` (Node, auto-resolves); set ` +
                `\`LELANTOS_PROVER_ARTIFACTS_DIR\` to a directory containing ` +
                `2x2.wasm + 2x2_final.zkey; pass \`proverArtifactsCdn\` to ` +
                `point at a self-hosted CDN base URL.`,
        );
        this.name = "ProverArtifactsMissingError";
        this.tried = tried;
    }
}
