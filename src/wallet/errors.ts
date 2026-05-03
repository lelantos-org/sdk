// Typed error classes thrown by the high-level Wallet API.
// Catch via `instanceof` or switch on `error.code` to react programmatically
// (e.g. trigger a consolidate-then-retry flow on InsufficientCoverError).

import type { StoredNote } from "./note-store.js";

/// Discriminator for typed wallet errors. Stable across versions — safe to
/// switch on. New codes may be added; treat `default:` as "unknown error".
export type WalletErrorCode =
    | "INSUFFICIENT_COVER"
    | "WALLET_CONFIG"
    | "RELAYER_TIMEOUT"
    | "RELAYER_FAILED"
    | "FMD_TIMEOUT"
    | "FMD_FAILED"
    | "PROVER_FAILED"
    | "PERMIT_REJECTED";

/// Base class — every typed SDK error inherits from this. Allows
/// `catch (e) { if (e instanceof WalletError) … }` without listing all
/// subclasses.
export class WalletError extends Error {
    readonly code: WalletErrorCode;
    constructor(code: WalletErrorCode, message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "WalletError";
        this.code = code;
    }
}

/// Thrown by `Wallet.transfer` / `Wallet.withdraw` when the SFRT selector
/// cannot find a 1- or 2-note cover for the requested amount, but the total
/// unspent balance for the asset IS sufficient. Caller should self-spend
/// `consolidate` first (combine into one note), re-sync, then retry — or
/// pass `autoConsolidate: true` to have the SDK do that for them.
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

/// Thrown when one or more required `WalletConfig` fields are missing.
/// `missing` lists every problem at once so callers see the full picture
/// instead of fixing them one round-trip at a time.
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

/// Thrown when an HTTP request to the relayer or fmd-webserver fails after
/// retries exhaust, or when a deadline passes. `cause` carries the
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

/// Thrown when Groth16 proof generation fails (witness mismatch, missing
/// artifacts, OOM in WASM). `cause` carries the prover's underlying error.
export class ProverError extends WalletError {
    constructor(message: string, opts?: { cause?: unknown }) {
        super("PROVER_FAILED", message, opts);
        this.name = "ProverError";
    }
}

/// Thrown when the user rejects an EIP-2612 permit signature in the wallet,
/// or when the signature returned is malformed.
export class PermitRejectedError extends WalletError {
    constructor(message = "user rejected permit signature", opts?: { cause?: unknown }) {
        super("PERMIT_REJECTED", message, opts);
        this.name = "PermitRejectedError";
    }
}
