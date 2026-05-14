// Base class + code enumeration. Every wallet-thrown error extends `WalletError`.

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

/// Base class for every typed SDK error.
export class WalletError extends Error {
    readonly code: WalletErrorCode;
    constructor(code: WalletErrorCode, message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "WalletError";
        this.code = code;
    }
}
