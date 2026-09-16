// Chain-side errors: accounts, signatures, adapter capabilities, RPC, transactions.

import { causeChain, WalletError, type WalletErrorOptions } from "./base.js";

/** Deposit path the SDK can take, given what the chain adapter implements. */
export type DepositStrategy = "native" | "allowance" | "witness";

/**
 * The operation needs an EVM account (to sign, hold public tokens, or pay gas)
 * and this wallet's chain layer is read-only.
 *
 * Spends from the pool need none: the circuit authorises them and the relayer
 * pays for them. Check `wallet.capabilities` (or `supportsDeposit(wallet)`)
 * before offering the action.
 */
export class NoEvmAccountError extends WalletError<"NO_EVM_ACCOUNT"> {
    /** The on-chain action that needed the account. */
    readonly operation: "deposit" | "cancelDeposit" | "setupDepositAllowance";

    constructor(
        opts?: WalletErrorOptions & {
            operation?: "deposit" | "cancelDeposit" | "setupDepositAllowance" | undefined;
        },
    ) {
        const operation = opts?.operation ?? "deposit";
        super(
            "NO_EVM_ACCOUNT",
            `${operation} needs an EVM account, and this wallet's chain layer is read-only; ` +
                "connect with a signer, a provider and address, or a private key",
            opts,
        );
        this.name = "NoEvmAccountError";
        this.operation = operation;
    }
}

/**
 * The configured chain adapter or submitter does not implement what the
 * operation needs, e.g. a custom adapter without `submitDepositNative`.
 */
export class UnsupportedOperationError extends WalletError<"UNSUPPORTED_OPERATION"> {
    /** The operation, and the path within it where relevant: `"deposit:native"`. */
    readonly operation: string;
    /** Adapter or config members that would make it possible. */
    readonly missing: string[];

    constructor(operation: string, missing: string[], opts?: WalletErrorOptions) {
        super(
            "UNSUPPORTED_OPERATION",
            `${operation} is not supported by this wallet's chain adapter or submitter ` +
                `(missing ${missing.join(", ")}); use an adapter that implements it, or another path`,
            opts,
        );
        this.name = "UnsupportedOperationError";
        this.operation = operation;
        this.missing = missing;
    }
}

/** What the user declined in their wallet. */
export type UserRejectedAction = "derive-key" | "sign-permit" | "send-tx";

/**
 * The user declined a prompt in their wallet: EIP-1193 code `4001`, or viem's
 * `UserRejectedRequestError`. Nothing was signed or sent.
 */
export class UserRejectedError extends WalletError<"USER_REJECTED"> {
    readonly action: UserRejectedAction;

    constructor(action: UserRejectedAction, opts?: WalletErrorOptions) {
        const what =
            action === "derive-key"
                ? "the key-derivation signature"
                : action === "sign-permit"
                  ? "the permit signature"
                  : "the transaction";
        super("USER_REJECTED", `user rejected ${what} in their wallet`, opts);
        this.name = "UserRejectedError";
        this.action = action;
    }
}

/**
 * Whether `err` is a wallet's "user rejected" answer, at any depth of `cause`.
 *
 * Recognises EIP-1193 code `4001` (on an `Error` or the plain object some
 * providers reject with), ethers' `ACTION_REJECTED`, and viem's
 * `UserRejectedRequestError` by name, so no viem import is needed.
 */
function isUserRejection(err: unknown): boolean {
    for (const cur of causeChain(err)) {
        if (cur instanceof UserRejectedError) return true;
        const { code, name } = cur as { code?: unknown; name?: unknown };
        if (code === 4001 || code === "ACTION_REJECTED") return true;
        if (name === "UserRejectedRequestError") return true;
    }
    return false;
}

/**
 * Rethrow `err` as {@link UserRejectedError} for `action` when it is a wallet
 * rejection; otherwise return it unchanged for the caller to throw.
 *
 * @internal
 */
export function asUserRejection(err: unknown, action: UserRejectedAction): unknown {
    if (err instanceof UserRejectedError) {
        return err.action === action ? err : new UserRejectedError(action, { cause: err.cause });
    }
    return isUserRejection(err) ? new UserRejectedError(action, { cause: err }) : err;
}

/**
 * A chain read or broadcast failed in transport: timeout, rate limit, dropped
 * connection, a node error. Retryable unless the node answered with a revert.
 */
export class ChainRpcError extends WalletError<"RPC_FAILED"> {
    /** Adapter method that failed, e.g. `"fetchAsset"`. */
    readonly method: string;

    constructor(method: string, opts?: WalletErrorOptions & { retryable?: boolean | undefined }) {
        super("RPC_FAILED", `chain RPC call ${method} failed`, {
            ...opts,
            retryable: opts?.retryable ?? true,
            context: { method, ...opts?.context },
        });
        this.name = "ChainRpcError";
        this.method = method;
    }
}

/** A transaction was mined and reverted. Resending it unchanged will revert again. */
export class TxRevertedError extends WalletError<"TX_REVERTED"> {
    readonly txHash: string;
    /** The contract's revert reason, when the node reported one. */
    readonly reason?: string | undefined;

    constructor(
        txHash: string,
        message: string,
        opts?: WalletErrorOptions & { reason?: string | undefined },
    ) {
        super("TX_REVERTED", message, opts);
        this.name = "TxRevertedError";
        // A field, never `context` or the message: a hash links an error report
        // to a specific on-chain operation.
        this.txHash = txHash;
        if (opts?.reason !== undefined) this.reason = opts.reason;
    }
}

/**
 * A transaction was sent but its receipt did not arrive, or did not carry the
 * expected event. Retryable: the receipt may still arrive; look it up by
 * `txHash` before sending again.
 */
export class TxMiningError extends WalletError<"TX_MINING"> {
    readonly txHash?: string | undefined;
    constructor(message: string, opts?: WalletErrorOptions & { txHash?: string | undefined }) {
        super("TX_MINING", message, { ...opts, retryable: true });
        this.name = "TxMiningError";
        // Exposed as a field and excluded from `context`. A transaction hash
        // links an error report to a specific on-chain operation.
        this.txHash = opts?.txHash;
    }
}
