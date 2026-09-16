// Narrowing: the discriminated union of every SDK error and its type guard.

import type { InternalError } from "./base.js";
import type {
    ChainRpcError,
    NoEvmAccountError,
    TxMiningError,
    TxRevertedError,
    UnsupportedOperationError,
    UserRejectedError,
} from "./chain.js";
import { WALLET_ERROR_CODES, type WalletErrorCode } from "./codes.js";
import type {
    EnvironmentError,
    InvalidArgumentError,
    NetworkNotDeployedError,
    WalletConfigError,
} from "./config.js";
import type {
    FeeAssetNotQuotedError,
    InsufficientBalanceError,
    InsufficientCoverError,
    NotesHeldError,
} from "./funds.js";
import type {
    NetworkError,
    NetworkErrorCode,
    TreeOutOfSyncError,
    WireFormatError,
} from "./network.js";
import type {
    ProverArtifactsFailedError,
    ProverArtifactsMissingError,
    ProverError,
    ProverUnavailableError,
} from "./prover.js";
import type {
    DeadlinePassedError,
    QuoteStaleError,
    RelayerRejectedError,
    SpendOutcomeUnknownError,
} from "./spend.js";
import type { WorkerErrorCode, WorkerRpcError } from "./worker.js";
import type { X402PaymentError } from "./x402.js";

const CODE_SET: ReadonlySet<string> = new Set(WALLET_ERROR_CODES);

/**
 * Union of every concrete SDK error, discriminated on `code`. Switching on
 * `code` narrows to the class carrying that variant's context fields.
 *
 * The two classes that cover several codes are expanded one code per member.
 * `Extract` (the basis of {@link WalletErrorOf} and the `code` overload of
 * {@link isWalletError}) matches a member only when its `code` is assignable to
 * the requested literal, which a union-typed `code` never is. Listing
 * `NetworkError` or `WorkerRpcError` once would make `WalletErrorOf` resolve to
 * `never` for their codes: the guard would return `true` at runtime while
 * narrowing away `url`, `status`, `body` and `method` at the type level.
 */
export type AnyWalletError =
    | WalletConfigError
    | NetworkNotDeployedError
    | EnvironmentError
    | InvalidArgumentError
    | NoEvmAccountError
    | UnsupportedOperationError
    | InsufficientBalanceError
    | NotesHeldError
    | InsufficientCoverError
    | FeeAssetNotQuotedError
    | DeadlinePassedError
    | QuoteStaleError
    | UserRejectedError
    | RelayerRejectedError
    | SpendOutcomeUnknownError
    | { [K in NetworkErrorCode]: NetworkError<K> }[NetworkErrorCode]
    | WireFormatError
    | ChainRpcError
    | TxRevertedError
    | TxMiningError
    | TreeOutOfSyncError
    | ProverError
    | ProverUnavailableError
    | ProverArtifactsMissingError
    | ProverArtifactsFailedError
    | { [K in WorkerErrorCode]: WorkerRpcError<K> }[WorkerErrorCode]
    | X402PaymentError
    | InternalError;

/** The error class carrying `code`. */
export type WalletErrorOf<C extends WalletErrorCode> = Extract<AnyWalletError, { code: C }>;

/**
 * Type guard for SDK errors in a `catch`. Pass `code` to test one variant.
 *
 * ```ts
 * try {
 *     await wallet.transfer({ to, amount });
 * } catch (err) {
 *     if (isWalletError(err, "INSUFFICIENT_COVER")) {
 *         // `err.consolidate` / `err.consolidateSum` are typed here.
 *         await wallet.transfer({ to, amount, autoConsolidate: true });
 *         return;
 *     }
 *     if (isWalletError(err, "NOTES_HELD") && err.retryable) {
 *         // Held by an earlier spend: `err.held` / `err.reservedUntil` are typed here.
 *         return scheduleRetry(err.reservedUntil);
 *     }
 *     if (isWalletError(err)) console.error(err.code, err.retryable, err.message);
 *     throw err;
 * }
 * ```
 *
 * Duck-typed rather than `instanceof`, so it still works when two copies of
 * the SDK end up in one bundle.
 */
export function isWalletError(err: unknown): err is AnyWalletError;
export function isWalletError<C extends WalletErrorCode>(
    err: unknown,
    code: C,
): err is WalletErrorOf<C>;
export function isWalletError(err: unknown, code?: WalletErrorCode): boolean {
    if (!(err instanceof Error)) return false;
    const actual = (err as { code?: unknown | undefined }).code;
    if (typeof actual !== "string" || !CODE_SET.has(actual)) return false;
    return code === undefined || actual === code;
}
