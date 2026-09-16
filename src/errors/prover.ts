// Prover errors.

import { WalletError, type WalletErrorOptions } from "./base.js";

/** Groth16 proof generation failure. `cause` carries the underlying error. */
export class ProverError extends WalletError<"PROVER_FAILED"> {
    constructor(message: string, opts?: WalletErrorOptions) {
        super("PROVER_FAILED", message, opts);
        this.name = "ProverError";
    }
}

/**
 * No prover can run here: its optional peer (`circom_runtime`, `snarkjs`) is not
 * installed, or its thread pool was shut down in this realm. Proving will not
 * work until the environment changes.
 */
export class ProverUnavailableError extends WalletError<"PROVER_UNAVAILABLE"> {
    constructor(message: string, opts?: WalletErrorOptions) {
        super("PROVER_UNAVAILABLE", message, opts);
        this.name = "ProverUnavailableError";
    }
}

/**
 * No prover artifacts available. Browser callers hit this whenever
 * neither `prover.artifacts` nor `prover.cdn` is set, because the
 * companion package has no public CDN fallback.
 */
export class ProverArtifactsMissingError extends WalletError<"PROVER_ARTIFACTS_MISSING"> {
    readonly tried: string[];
    /** Shape whose artifacts were sought, e.g. `"4x6"`. */
    readonly shape: string;
    // The default is `shapeId(DEFAULT_SHAPE)` spelled as a literal: `errors/` imports only `core/`,
    // and `protocol/shape.test.ts` pins the two together.
    constructor(tried: string[], shape = "4x6", opts?: WalletErrorOptions) {
        super(
            "PROVER_ARTIFACTS_MISSING",
            `prover artifacts for the ${shape} circuit not found. ` +
                `Tried: ${tried.join(", ")}. ` +
                `Fixes (any one): pass \`prover: { artifacts: { circuit, zkey } }\` to ` +
                `connect() (browser must do this or set \`prover.cdn\` — no built-in CDN); ` +
                `install \`@lelantos-org/circuits\` (Node, auto-resolves); set ` +
                `\`LELANTOS_PROVER_ARTIFACTS_DIR\` to a directory containing ` +
                `${shape}.wasm + ${shape}_final.zkey; pass \`prover: { cdn }\` to ` +
                `point at a self-hosted base URL.`,
            opts,
        );
        this.name = "ProverArtifactsMissingError";
        this.tried = tried;
        this.shape = shape;
    }
}

/** Artifacts were located but could not be loaded (I/O, HTTP, timeout). */
export class ProverArtifactsFailedError extends WalletError<"PROVER_ARTIFACTS_FAILED"> {
    readonly source: string;
    /** `retryable` is false for 4xx and other failures that will not fix themselves. */
    constructor(
        source: string,
        message: string,
        opts?: WalletErrorOptions & { retryable?: boolean | undefined },
    ) {
        super("PROVER_ARTIFACTS_FAILED", `${message} (${source})`, opts);
        this.name = "ProverArtifactsFailedError";
        this.source = source;
    }
}
