// Every typed error the SDK throws.
//
// Throwing rule
// -------------
// Throw a typed `WalletError` at every boundary the caller can act on:
// config, network, prover, chain, selection, submission, wire format.
// Throw a bare `Error` only for programmer errors inside a single module —
// invariant violations that indicate an SDK bug, or structurally invalid
// arguments to an `@internal` pure function.
//
// This module sits at tier 0: it imports nothing from `src/`, so every
// layer can throw typed errors without an upward dependency.

import type { ConsolidateHint } from "./note-record.js";
import { DEFAULT_SHAPE, shapeId } from "./shape.js";

/**
 * Every code the SDK can throw. Exported as a value so callers can
 * enumerate or validate codes at runtime.
 */
export const WALLET_ERROR_CODES = [
    "INSUFFICIENT_COVER",
    "WALLET_CONFIG",
    "INVALID_ARGUMENT",
    "ENVIRONMENT",
    "RELAYER_TIMEOUT",
    "RELAYER_FAILED",
    "FMD_TIMEOUT",
    "FMD_FAILED",
    "WIRE_FORMAT",
    "PROVER_FAILED",
    "PROVER_ARTIFACTS_MISSING",
    "PROVER_ARTIFACTS_FAILED",
    "PERMIT_REJECTED",
    "DEPOSIT_ADAPTER",
    "TX_MINING",
    "SELECTION",
    "X402_PAYMENT",
    "NETWORK_NOT_DEPLOYED",
    "WORKER_TIMEOUT",
    "WORKER_CRASHED",
    "WORKER_FAILED",
    "INTERNAL",
] as const;

/** Stable discriminator. New codes may be added; treat `default:` as unknown. */
export type WalletErrorCode = (typeof WALLET_ERROR_CODES)[number];

const CODE_SET: ReadonlySet<string> = new Set(WALLET_ERROR_CODES);

/**
 * Ambient facts about the operation that failed. Populated as the error
 * travels outward, so a failure deep in a swap still reports the id of the
 * operation and the hash of any transaction already broadcast.
 */
export interface ErrorContext {
    /** Correlation id, minted once per wallet operation. */
    opId?: string | undefined;
    /** Operation name, e.g. `"deposit"` or `"swap:leg1"`. */
    op?: string | undefined;
    /**
     * Hash of a transaction already broadcast when the failure occurred. Set
     * only by callers that opt in; `TxMiningError` exposes it as a typed field.
     */
    txHash?: string | undefined;
    url?: string | undefined;
    method?: string | undefined;
    requestId?: number | undefined;
    [k: string]: unknown;
}

export interface WalletErrorOptions {
    cause?: unknown | undefined;
    context?: ErrorContext | undefined;
}

/**
 * Base class for every typed SDK error. Subclasses set `name`, pin `code`
 * to a literal, and may attach typed context fields.
 *
 * The `C` parameter makes {@link AnyWalletError} a discriminated union, so
 * `if (e.code === "INSUFFICIENT_COVER")` narrows to
 * {@link InsufficientCoverError} without an `instanceof` chain.
 */
export class WalletError<C extends WalletErrorCode = WalletErrorCode> extends Error {
    readonly code: C;
    readonly context: ErrorContext;

    constructor(code: C, message: string, options?: WalletErrorOptions) {
        super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
        this.name = "WalletError";
        this.code = code;
        this.context = { ...options?.context };
    }

    /** Merge additional context in place and return `this` for rethrowing. */
    withContext(extra: ErrorContext): this {
        Object.assign(this.context, extra);
        return this;
    }
}

/**
 * Attach context to anything thrown. Typed SDK errors are enriched in place;
 * anything else is wrapped so the context is never lost.
 */
export function attachContext(err: unknown, context: ErrorContext): unknown {
    if (err instanceof WalletError) return err.withContext(context);
    if (isWalletError(err)) {
        // A duplicate SDK copy in the bundle: duck-typed, so mutate defensively.
        const bag = (err as { context?: ErrorContext | undefined }).context;
        if (bag) Object.assign(bag, context);
        return err;
    }
    return new InternalError(err instanceof Error ? err.message : String(err), {
        cause: err,
        context,
    });
}

// --- Configuration -----------------------------------------------------------

/** `missing` lists every problem at once. */
export class WalletConfigError extends WalletError<"WALLET_CONFIG"> {
    readonly missing: string[];
    constructor(missing: string[] | string, opts?: WalletErrorOptions) {
        const list = Array.isArray(missing) ? missing : [missing];
        super(
            "WALLET_CONFIG",
            list.length === 1
                ? `wallet config: ${list[0]}`
                : `wallet config: missing or invalid — ${list.join("; ")}`,
            opts,
        );
        this.name = "WalletConfigError";
        this.missing = list;
    }
}

/**
 * A caller passed an argument the SDK cannot act on. Distinct from
 * {@link WalletConfigError}, which is about wiring rather than a call.
 */
export class InvalidArgumentError extends WalletError<"INVALID_ARGUMENT"> {
    readonly argument?: string | undefined;
    constructor(message: string, opts?: WalletErrorOptions & { argument?: string | undefined }) {
        super("INVALID_ARGUMENT", message, opts);
        this.name = "InvalidArgumentError";
        this.argument = opts?.argument;
    }
}

/** A required platform capability is missing (Web Crypto, workers, fetch). */
export class EnvironmentError extends WalletError<"ENVIRONMENT"> {
    constructor(message: string, opts?: WalletErrorOptions) {
        super("ENVIRONMENT", message, opts);
        this.name = "EnvironmentError";
    }
}

/**
 * Preset is a placeholder pending public deployment. Surfaces at
 * `connect()` time instead of failing later as "invalid address".
 */
export class NetworkNotDeployedError extends WalletError<"NETWORK_NOT_DEPLOYED"> {
    readonly network: string;
    constructor(network: string, opts?: WalletErrorOptions) {
        super(
            "NETWORK_NOT_DEPLOYED",
            `network "${network}" has no public deployment yet. Pass a ` +
                `custom \`NetworkPreset\` with concrete addresses, or pick ` +
                `\`anvil\`/\`localnet\` for local dev.`,
            opts,
        );
        this.name = "NetworkNotDeployedError";
        this.network = network;
    }
}

// --- Network / HTTP ----------------------------------------------------------

export type NetworkTimeoutCode = "RELAYER_TIMEOUT" | "FMD_TIMEOUT";
export type NetworkFailureCode = "RELAYER_FAILED" | "FMD_FAILED";
export type NetworkErrorCode = NetworkTimeoutCode | NetworkFailureCode;

/**
 * HTTP failure after retries, or deadline expired. `cause` carries the
 * underlying network error.
 */
export class NetworkError extends WalletError<NetworkErrorCode> {
    readonly url: string;
    readonly status?: number | undefined;
    /** Response body of the last failed attempt, truncated. */
    readonly body?: string | undefined;

    constructor(
        code: NetworkErrorCode,
        url: string,
        message: string,
        opts?: WalletErrorOptions & { status?: number | undefined; body?: string | undefined },
    ) {
        super(code, `${message} (${url})`, opts);
        this.name = "NetworkError";
        this.url = url;
        this.status = opts?.status;
        this.body = opts?.body;
        this.context.url ??= url;
    }
}

/** A server response did not match the documented wire contract. */
export class WireFormatError extends WalletError<"WIRE_FORMAT"> {
    /** JSON path of the offending value, e.g. `$.pathElements[3][1]`. */
    readonly path: string;
    constructor(path: string, message: string, opts?: WalletErrorOptions) {
        super("WIRE_FORMAT", `${message} at ${path}`, opts);
        this.name = "WireFormatError";
        this.path = path;
    }
}

// --- Prover ------------------------------------------------------------------

/** Groth16 proof generation failure. `cause` carries the underlying error. */
export class ProverError extends WalletError<"PROVER_FAILED"> {
    constructor(message: string, opts?: WalletErrorOptions) {
        super("PROVER_FAILED", message, opts);
        this.name = "ProverError";
    }
}

/**
 * No prover artifacts available. Browser callers hit this whenever
 * neither `proverArtifacts` nor `proverArtifactsCdn` is set, because the
 * companion package has no public CDN fallback.
 */
export class ProverArtifactsMissingError extends WalletError<"PROVER_ARTIFACTS_MISSING"> {
    readonly tried: string[];
    /** Shape whose artifacts were sought, e.g. `"2x2"`. */
    readonly shape: string;
    constructor(tried: string[], shape = shapeId(DEFAULT_SHAPE), opts?: WalletErrorOptions) {
        super(
            "PROVER_ARTIFACTS_MISSING",
            `prover artifacts for the ${shape} circuit not found. ` +
                `Tried: ${tried.join(", ")}. ` +
                `Fixes (any one): pass \`proverArtifacts: { circuit, zkey }\` to ` +
                `connect() (browser must do this — no built-in CDN); install ` +
                `\`@lelantos-org/circuits\` (Node, auto-resolves); set ` +
                `\`LELANTOS_PROVER_ARTIFACTS_DIR\` to a directory containing ` +
                `${shape}.wasm + ${shape}_final.zkey; pass \`proverArtifactsCdn\` to ` +
                `point at a self-hosted CDN base URL.`,
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
    /** False for 4xx and other failures that will not fix themselves. */
    readonly retryable: boolean;
    constructor(
        source: string,
        message: string,
        opts?: WalletErrorOptions & { retryable?: boolean | undefined },
    ) {
        super("PROVER_ARTIFACTS_FAILED", `${message} (${source})`, opts);
        this.name = "ProverArtifactsFailedError";
        this.source = source;
        this.retryable = opts?.retryable ?? false;
    }
}

// --- Workers -----------------------------------------------------------------

export type WorkerErrorCode = "WORKER_TIMEOUT" | "WORKER_CRASHED" | "WORKER_FAILED";

/**
 * A worker RPC call failed. `cause` carries the reconstructed remote error,
 * whose `stack` is the one from inside the worker; this error's own stack is
 * the call site on the main thread.
 */
export class WorkerRpcError extends WalletError<WorkerErrorCode> {
    readonly method?: string | undefined;
    constructor(
        code: WorkerErrorCode,
        message: string,
        opts?: WalletErrorOptions & { method?: string | undefined },
    ) {
        super(code, message, opts);
        this.name = "WorkerRpcError";
        this.method = opts?.method;
    }
}

// --- Tx construction / selection / submission -------------------------------

/**
 * The balance covers `target`, but no combination within the circuit's input
 * arity does. Merging the notes in `consolidate` into one fixes it.
 *
 * `consolidationAttempted` distinguishes the two ways this is reached, which a
 * caller has to tell apart to say anything useful:
 *
 *   * `false` — the caller did not ask for consolidation. Self-spend
 *     `consolidate`, re-sync, and retry, or pass `{ autoConsolidate: true }`.
 *   * `true` — consolidation ran and the cover still did not appear. Repeating
 *     the same call will not help; suggesting `autoConsolidate` here is what
 *     the old single-message version wrongly did.
 */
export class InsufficientCoverError extends WalletError<"INSUFFICIENT_COVER"> {
    readonly target: bigint;
    readonly asset: bigint;
    readonly consolidate: ConsolidateHint[];
    readonly consolidateSum: bigint;
    /** Whether consolidation ran before this was thrown. */
    readonly consolidationAttempted: boolean;

    constructor(
        args: {
            target: bigint;
            asset: bigint;
            consolidate: ConsolidateHint[];
            consolidateSum: bigint;
            consolidationAttempted?: boolean | undefined;
        },
        opts?: WalletErrorOptions,
    ) {
        // Counted off the hint list rather than hardcoded: the message said
        // "2-note cover ... two smallest" long after the deployed shape moved
        // to four inputs, so it named a rule the selector was not applying.
        const n = args.consolidate.length;
        const notes = `${n} smallest note${n === 1 ? "" : "s"}`;
        const attempted = args.consolidationAttempted ?? false;
        // Amounts, asset ids and note ids are exposed as fields and excluded
        // from the message, which reaches application logs verbatim.
        const detail = attempted
            ? ` after consolidating; the ${notes} (see \`consolidate\`) still do not combine ` +
              "to reach the target"
            : `; consolidate the ${notes} (see \`consolidate\`), then re-run — or pass ` +
              "{ autoConsolidate: true }";
        super("INSUFFICIENT_COVER", `no cover within the circuit's input arity${detail}`, opts);
        this.name = "InsufficientCoverError";
        this.target = args.target;
        this.asset = args.asset;
        this.consolidate = args.consolidate;
        this.consolidateSum = args.consolidateSum;
        this.consolidationAttempted = attempted;
    }
}

/** User rejected the permit signature, or sig was malformed. */
export class PermitRejectedError extends WalletError<"PERMIT_REJECTED"> {
    constructor(message = "user rejected permit signature", opts?: WalletErrorOptions) {
        super("PERMIT_REJECTED", message, opts);
        this.name = "PermitRejectedError";
    }
}

/** Deposit path the SDK can take, given what the chain adapter implements. */
export type DepositStrategy = "native" | "allowance" | "witness";

/** Adapter/Submitter cannot satisfy the requested deposit path. */
export class DepositAdapterError extends WalletError<"DEPOSIT_ADAPTER"> {
    readonly strategy: DepositStrategy;
    readonly missing: string[];
    constructor(strategy: DepositStrategy, missing: string[], opts?: WalletErrorOptions) {
        super(
            "DEPOSIT_ADAPTER",
            `deposit(${strategy}): chain adapter is missing ${missing.join(", ")} — upgrade adapter or pick a different strategy`,
            opts,
        );
        this.name = "DepositAdapterError";
        this.strategy = strategy;
        this.missing = missing;
    }
}

/**
 * Unrecoverable selection failure (no spendable notes, RNG missing).
 * Use `InsufficientCoverError` for the consolidate-then-retry case.
 */
export class SelectionError extends WalletError<"SELECTION"> {
    readonly asset?: bigint | undefined;
    constructor(message: string, opts?: WalletErrorOptions & { asset?: bigint | undefined }) {
        super("SELECTION", message, opts);
        this.name = "SelectionError";
        this.asset = opts?.asset;
    }
}

/**
 * Why an x402 payment was refused. Every value means *no funds moved* —
 * the checks all run before `wallet.transfer`/`wallet.withdraw` is called.
 */
export type X402RefusalReason =
    /** Cumulative spend for this asset would exceed `budget.total`. */
    | "budget-exceeded"
    /** This single payment exceeds `budget.perRequest`. */
    | "per-request-limit"
    /** Request host is not in `allowHosts`. */
    | "host-not-allowed"
    /** Nothing in `accepts[]` is payable by this wallet. */
    | "no-acceptable-requirements"
    /** Requirements are malformed, or name a chain/pool this wallet is not on. */
    | "unsupported-requirements"
    /** Server returned 402 again after a payment was attached. */
    | "payment-rejected";

/**
 * An x402 payment could not be made. Callers branch on `reason`: a
 * `budget-exceeded` is a policy stop the agent should surface to its
 * operator, while `no-acceptable-requirements` means this server cannot be
 * paid by this wallet.
 */
export class X402PaymentError extends WalletError<"X402_PAYMENT"> {
    readonly reason: X402RefusalReason;
    /** Resource URL the payment was for, when known. */
    readonly resource?: string | undefined;

    constructor(
        reason: X402RefusalReason,
        message: string,
        opts?: WalletErrorOptions & { resource?: string | undefined },
    ) {
        super("X402_PAYMENT", message, opts);
        this.name = "X402PaymentError";
        this.reason = reason;
        // Exposed as a field and excluded from `context`, which error
        // reporters serialise in full. The resource URL identifies the paid
        // APIs this wallet calls.
        this.resource = opts?.resource;
    }
}

/** EVM tx failed to mine or returned no receipt. */
export class TxMiningError extends WalletError<"TX_MINING"> {
    readonly txHash?: string | undefined;
    constructor(message: string, opts?: WalletErrorOptions & { txHash?: string | undefined }) {
        super("TX_MINING", message, opts);
        this.name = "TxMiningError";
        // Exposed as a field and excluded from `context`. A transaction hash
        // links an error report to a specific on-chain operation.
        this.txHash = opts?.txHash;
    }
}

/** An SDK invariant broke, or a non-Error value was thrown. Report it. */
export class InternalError extends WalletError<"INTERNAL"> {
    constructor(message: string, opts?: WalletErrorOptions) {
        super("INTERNAL", message, opts);
        this.name = "InternalError";
    }
}

// --- Narrowing ---------------------------------------------------------------

/**
 * Union of every concrete SDK error, discriminated on `code`. Switching on
 * `code` narrows to the class carrying that variant's context fields.
 */
export type AnyWalletError =
    | WalletConfigError
    | InvalidArgumentError
    | EnvironmentError
    | NetworkNotDeployedError
    | NetworkError
    | WireFormatError
    | ProverError
    | ProverArtifactsMissingError
    | ProverArtifactsFailedError
    | WorkerRpcError
    | InsufficientCoverError
    | PermitRejectedError
    | DepositAdapterError
    | SelectionError
    | X402PaymentError
    | TxMiningError
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
 *     if (isWalletError(err)) console.error(err.code, err.message);
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
