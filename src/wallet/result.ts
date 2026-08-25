import type { AssetId, CircuitAmount, Hex32 } from "../core/brand.js";
import type { DepositStrategy } from "../core/errors.js";

// Wallet operation result types. Re-exported from `./api.ts` and the public barrel.

/**
 * Common fields on every receipt variant. `kind` is the discriminator.
 */
interface TxResultBase {
    txHash: Hex32;
    /**
     * Commitments created by the tx, in output-slot order. One per output
     * slot of the transact circuit: four at the default 4×4 shape.
     */
    commitments: Hex32[];
    /**
     * Subset of `commitments` with non-zero value (zero-value outputs are
     * circuit pads that no party's scanner accepts). Receiver-side
     * waiters should `filter` this against their own commitments.
     */
    nonZeroCommitments: Hex32[];
    /** Subset of `commitments` recoverable via this wallet's FMD scan. */
    ownCommitments: Hex32[];
    /** Total value of own outputs; pending balance once FMD indexes them. */
    ownInflow: CircuitAmount;
}

/** Result of `wallet.deposit`. No spent notes (escrow pulls funds via Permit2). */
export interface DepositResult extends TxResultBase {
    kind: "deposit";
    /**
     * Which deposit path was taken, as chosen from the adapter's capability
     * probes.
     */
    strategy: DepositStrategy;
    /** Gross publicIn (circuit units) the depositor sent into escrow. */
    sent: CircuitAmount;
    /**
     * On-chain deposit id from `MASP.deposit`. Absent only if the
     * submitter path didn't surface one (relayer batch flow).
     */
    depositId?: bigint;
}

/**
 * Result of `wallet.transfer`. Spends 1-2 input notes; outputs are
 * `[recipientNote, changeNote]` (or `[selfA, selfB]` on self-transfer).
 */
export interface TransferResult extends TxResultBase {
    kind: "transfer";
    spent: string[];
    inputSum: CircuitAmount;
    sent: CircuitAmount;
    change: CircuitAmount;
}

/**
 * Result of `wallet.withdraw` / `wallet.withdrawEth`. Both outputs are
 * change-to-self; `sent` is the gross publicOut paid to the recipient.
 */
export interface WithdrawResult extends TxResultBase {
    kind: "withdraw";
    spent: string[];
    inputSum: CircuitAmount;
    /** publicOut paid to the L1 recipient (gross, includes fee). */
    sent: CircuitAmount;
    change: CircuitAmount;
}

/**
 * Result of `wallet.swap`. Leg-1 (withdraw → wrapper) + leg-2 (B-note
 * deposit) bundled atomically; only leg-1 commitments surface here.
 */
export interface SwapResult extends TxResultBase {
    kind: "swap";
    spent: string[];
    inputSum: CircuitAmount;
    /** publicOut leg-1 paid to the wrapper. */
    sent: CircuitAmount;
    change: CircuitAmount;
    /** On-chain deposit id of the leg-2 B-note deposit, if available. */
    depositId?: bigint;
}

/** Discriminated union over per-tx receipt shapes. Switch on `kind`. */
export type TransactionResult = DepositResult | TransferResult | WithdrawResult | SwapResult;

/**
 * Plaintext payload of a recovered note. Cryptographic fields for
 * custom proofs against the low-level builders.
 */
export interface WalletNotePayload {
    asset: AssetId;
    value: CircuitAmount;
    rho: bigint;
    rcm: bigint;
    rcvDep: bigint;
}

/** Friendly note view returned by `wallet.notes()`. */
export interface WalletNote {
    id: string;
    asset: AssetId;
    value: CircuitAmount;
    spent: boolean;
    firstSeenBlock?: number;
    /** ISO-8601. */
    discoveredAt: string;
    cm: Hex32;
    /** Decoded payload. Recomputes on each call. */
    notePayload(): WalletNotePayload;
}
