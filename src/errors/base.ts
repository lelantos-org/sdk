// Every typed error the SDK throws.
//
// Throwing rule
// -------------
// Every failure that leaves the SDK is a `WalletError`, so a caller branches on
// `err.code` and never on message text:
//
//   * a caller's bad input            → `InvalidArgumentError` (names the `argument`);
//   * a server response off-contract  → `WireFormatError` (names the JSON `path`);
//   * a missing platform capability   → `EnvironmentError`;
//   * a broken SDK invariant          → `assertInvariant` / `InternalError`.
//
// `scripts/check-throws.mjs` fails the build on a bare `throw new Error` (or
// `RangeError`/`TypeError`) in non-test sources, and `boundary()` wraps every
// public wallet method so a stray third-party throw still surfaces as `INTERNAL`.
//
// Messages reach application logs verbatim, so they carry no amounts, asset or
// note ids, addresses, URLs with credentials, or response bodies. Those live on
// typed fields (or `details`), which a reporter can choose to drop.
//
// Tier 0: `errors/` imports only `core/` (enforced by `scripts/check-layers.mjs`), so every layer
// can throw typed errors without an upward dependency.
//
// Split by domain; the root entry (`@lelantos-org/sdk`) publishes every class.

import type { WalletErrorCode } from "./codes.js";
import { isWalletError } from "./guard.js";

/** `err.message` for an `Error`, else `String(err)`. For logs and wrapped errors. */
export function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** Depth bound for {@link causeChain}; guards a cyclic `cause`. */
const MAX_CAUSE_DEPTH = 10;

/** `err`, then each object down its `cause` chain, stopping at the first non-object. */
export function* causeChain(err: unknown): Generator<object> {
    let cur = err;
    for (
        let depth = 0;
        depth < MAX_CAUSE_DEPTH && cur !== null && typeof cur === "object";
        depth++
    ) {
        yield cur;
        cur = (cur as { cause?: unknown }).cause;
    }
}

/**
 * Ambient facts about the operation that failed. Populated as the error
 * travels outward, so a failure deep in a swap still reports the id and name
 * of the operation it belongs to.
 *
 * Closed: facts specific to one failure are typed fields on its class, or
 * {@link WalletError.details}.
 */
export interface ErrorContext {
    /** Correlation id, minted once per wallet operation. */
    opId?: string | undefined;
    /** Operation name, e.g. `"deposit"` or `"swap:leg1"`. */
    op?: string | undefined;
    /** Redacted URL of the request that failed. */
    url?: string | undefined;
    /** HTTP method, or the worker/RPC method that failed. */
    method?: string | undefined;
}

/** Diagnostic scalars attached to one error. Never secrets. */
export type ErrorDetails = Readonly<Record<string, string | number | boolean>>;

export interface WalletErrorOptions {
    cause?: unknown | undefined;
    context?: ErrorContext | undefined;
    details?: ErrorDetails | undefined;
}

/**
 * Base class for every typed SDK error. Subclasses set `name`, pin `code`
 * to a literal, and may attach typed fields.
 *
 * The `C` parameter makes {@link AnyWalletError} a discriminated union, so
 * `if (e.code === "INSUFFICIENT_COVER")` narrows to
 * {@link InsufficientCoverError} without an `instanceof` chain.
 */
export class WalletError<C extends WalletErrorCode = WalletErrorCode> extends Error {
    readonly code: C;
    /**
     * Whether the same call, unchanged, may succeed later without user action:
     * a timeout, a 5xx, notes held by an earlier spend. `false` means retrying
     * as-is will fail the same way.
     */
    readonly retryable: boolean;
    readonly context: ErrorContext;
    /** Extra diagnostic scalars for this failure, when any. */
    readonly details?: ErrorDetails | undefined;

    constructor(
        code: C,
        message: string,
        options?: WalletErrorOptions & { retryable?: boolean | undefined },
    ) {
        super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
        this.name = "WalletError";
        this.code = code;
        this.retryable = options?.retryable ?? false;
        this.context = { ...options?.context };
        if (options?.details !== undefined) this.details = options.details;
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
    // Duck-typed, so an error from a duplicate SDK copy in the bundle is enriched too.
    if (isWalletError(err)) {
        if (err.context) Object.assign(err.context, context);
        return err;
    }
    return new InternalError(errMessage(err), { cause: err, context });
}

/** An SDK invariant broke, or a non-SDK value was thrown past a public method. Report it. */
export class InternalError extends WalletError<"INTERNAL"> {
    constructor(message: string, opts?: WalletErrorOptions) {
        super("INTERNAL", message, opts);
        this.name = "InternalError";
    }
}

/**
 * Throw {@link InternalError} unless `condition` holds.
 *
 * For states the SDK itself guarantees: a failure is a bug, never the
 * caller's input (use `InvalidArgumentError`) or a server's response (use
 * `WireFormatError`).
 */
export function assertInvariant(
    condition: unknown,
    message: string,
    details?: ErrorDetails | undefined,
): asserts condition {
    if (!condition) {
        throw new InternalError(message, details !== undefined ? { details } : undefined);
    }
}

/**
 * Assert a union has been handled exhaustively.
 *
 * Call it where a discriminated union's variants have all been consumed. An
 * unhandled variant stops `x` narrowing to `never`, so the call fails to
 * compile. The runtime throw covers only values arriving from untyped input.
 *
 * ```ts
 * if (s === "native") return a();
 * if (s === "allowance") return b();
 * assertNever(s, "deposit strategy");
 * ```
 */
export function assertNever(x: never, what: string): never {
    throw new InternalError(`unhandled ${what}: ${String(x)}`);
}
