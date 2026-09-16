// The stable `code` discriminators every SDK error carries.

/**
 * Every code the SDK can throw. Exported as a value so callers can
 * enumerate or validate codes at runtime.
 *
 * Grouped by what the caller does about it:
 *
 *   * configuration and arguments: fix the call or the wiring;
 *   * funds: wait, top up, consolidate, or pick another fee asset;
 *   * submission: the relayer's answer, or the absence of one;
 *   * transport, chain, prover, worker: infrastructure, often `retryable`;
 *   * `INTERNAL`: an SDK bug; report it.
 */
export const WALLET_ERROR_CODES = [
    // configuration and arguments
    "WALLET_CONFIG",
    "NETWORK_NOT_DEPLOYED",
    "ENVIRONMENT",
    "INVALID_ARGUMENT",
    "NO_EVM_ACCOUNT",
    "UNSUPPORTED_OPERATION",
    // funds
    "INSUFFICIENT_BALANCE",
    "NOTES_HELD",
    "INSUFFICIENT_COVER",
    "FEE_ASSET_NOT_QUOTED",
    // submission
    "DEADLINE_PASSED",
    "QUOTE_STALE",
    "USER_REJECTED",
    "RELAYER_REJECTED",
    "SPEND_OUTCOME_UNKNOWN",
    // transport
    "RELAYER_TIMEOUT",
    "RELAYER_FAILED",
    "FMD_TIMEOUT",
    "FMD_FAILED",
    "QUOTER_TIMEOUT",
    "QUOTER_FAILED",
    "WIRE_FORMAT",
    // chain
    "RPC_FAILED",
    "TX_REVERTED",
    "TX_MINING",
    "TREE_OUT_OF_SYNC",
    // prover and workers
    "PROVER_FAILED",
    "PROVER_UNAVAILABLE",
    "PROVER_ARTIFACTS_MISSING",
    "PROVER_ARTIFACTS_FAILED",
    "WORKER_TIMEOUT",
    "WORKER_CRASHED",
    "WORKER_FAILED",
    // x402
    "X402_PAYMENT",
    "INTERNAL",
] as const;

/** Stable discriminator. New codes may be added; treat `default:` as unknown. */
export type WalletErrorCode = (typeof WALLET_ERROR_CODES)[number];
