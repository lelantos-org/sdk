// Errors raised during tx construction, selection, and submission.

import type { StoredNote } from "../note-store.js";
import { WalletError } from "./base.js";

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
