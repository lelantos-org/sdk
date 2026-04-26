// All wallet-thrown errors. Single file so callers can `import { ... } from
// "../wallet/errors.js"` without remembering which subfile owns which class.

import type { StoredNote } from "./note-store.js";

/// Stable discriminator. New codes may be added; treat `default:` as unknown.
export type WalletErrorCode =
    | "INSUFFICIENT_COVER"
    | "WALLET_CONFIG"
    | "RELAYER_TIMEOUT"
    | "RELAYER_FAILED"
    | "FMD_TIMEOUT"
    | "FMD_FAILED"
    | "PROVER_FAILED"
    | "PROVER_ARTIFACTS_MISSING"
    | "PERMIT_REJECTED"
    | "DEPOSIT_ADAPTER"
    | "TX_MINING"
    | "SELECTION"
    | "NETWORK_NOT_DEPLOYED";

/// Base class for every typed SDK error. Subclasses set `name` and may
/// attach typed context fields.
export class WalletError extends Error {
    readonly code: WalletErrorCode;
    constructor(code: WalletErrorCode, message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "WalletError";
        this.code = code;
    }
}

// --- Configuration -----------------------------------------------------------

/// `missing` lists every problem at once.
export class WalletConfigError extends WalletError {
    readonly missing: string[];
    constructor(missing: string[] | string) {
        const list = Array.isArray(missing) ? missing : [missing];
        super(
            "WALLET_CONFIG",
            list.length === 1
                ? `wallet config: ${list[0]}`
                : `wallet config: missing or invalid — ${list.join("; ")}`,
        );
        this.name = "WalletConfigError";
        this.missing = list;
    }
}

/// Preset is a placeholder pending public deployment. Surfaces at
/// `Wallet.connect` time instead of failing later as "invalid address".
export class NetworkNotDeployedError extends WalletError {
    readonly network: string;
    constructor(network: string) {
        super(
            "NETWORK_NOT_DEPLOYED",
            `network "${network}" has no public deployment yet. Pass a ` +
                `custom \`NetworkPreset\` with concrete addresses, or pick ` +
                `\`anvil\`/\`localnet\` for local dev.`,
        );
        this.name = "NetworkNotDeployedError";
        this.network = network;
    }
}

// --- Network / HTTP ----------------------------------------------------------

/// HTTP failure after retries, or deadline expired. `cause` carries the
/// underlying network error.
export class NetworkError extends WalletError {
    readonly url: string;
    readonly status?: number;
    constructor(
        code: "RELAYER_TIMEOUT" | "RELAYER_FAILED" | "FMD_TIMEOUT" | "FMD_FAILED",
        url: string,
        message: string,
        opts?: { status?: number; cause?: unknown },
    ) {
        super(code, `${message} (${url})`, opts);
        this.name = "NetworkError";
        this.url = url;
        this.status = opts?.status;
    }
}

// --- Prover ------------------------------------------------------------------

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

// --- Tx construction / selection / submission -------------------------------

/// No 1- or 2-note cover, but total balance is sufficient. Caller should
/// self-spend `consolidate` first, re-sync, then retry — or pass
/// `autoConsolidate: true`.
export class InsufficientCoverError extends WalletError {
    readonly target: bigint;
    readonly asset: bigint;
    readonly consolidate: StoredNote[];
    readonly consolidateSum: bigint;

    constructor(args: {
        target: bigint;
        asset: bigint;
        consolidate: StoredNote[];
        consolidateSum: bigint;
    }) {
        const ids = args.consolidate.map((n) => n.id).join(", ");
        super(
            "INSUFFICIENT_COVER",
            `insufficient 2-note cover for ${args.target} (asset ${args.asset}); consolidate two smallest notes first (ids: ${ids}, sum: ${args.consolidateSum}), then re-run — or pass { autoConsolidate: true }`,
        );
        this.name = "InsufficientCoverError";
        this.target = args.target;
        this.asset = args.asset;
        this.consolidate = args.consolidate;
        this.consolidateSum = args.consolidateSum;
    }
}

/// User rejected the permit signature, or sig was malformed.
export class PermitRejectedError extends WalletError {
    constructor(message = "user rejected permit signature", opts?: { cause?: unknown }) {
        super("PERMIT_REJECTED", message, opts);
        this.name = "PermitRejectedError";
    }
}

/// Adapter/Submitter cannot satisfy the requested deposit path.
export type DepositStrategy = "native" | "allowance" | "witness";

export class DepositAdapterError extends WalletError {
    readonly strategy: DepositStrategy;
    readonly missing: string[];
    constructor(strategy: DepositStrategy, missing: string[]) {
        super(
            "DEPOSIT_ADAPTER",
            `deposit(${strategy}): chain adapter is missing ${missing.join(", ")} — upgrade adapter or pick a different strategy`,
        );
        this.name = "DepositAdapterError";
        this.strategy = strategy;
        this.missing = missing;
    }
}

/// Unrecoverable selection failure (no spendable notes, RNG missing).
/// Use `InsufficientCoverError` for the consolidate-then-retry case.
export class SelectionError extends WalletError {
    readonly asset?: bigint;
    constructor(message: string, opts?: { asset?: bigint }) {
        super("SELECTION", message);
        this.name = "SelectionError";
        this.asset = opts?.asset;
    }
}

/// EVM tx failed to mine or returned no receipt.
export class TxMiningError extends WalletError {
    readonly txHash?: string;
    constructor(message: string, opts?: { txHash?: string; cause?: unknown }) {
        super("TX_MINING", message, { cause: opts?.cause });
        this.name = "TxMiningError";
        this.txHash = opts?.txHash;
    }
}
