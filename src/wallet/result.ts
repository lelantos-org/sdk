// Wallet operation result types. Re-exported from `./api.ts` and the public barrel.

/// Common fields on every receipt variant. The `kind` discriminator
/// tells you which variant you have.
interface TxResultBase {
    txHash: string;
    /// 0x-hex commitments created by the tx. Always length 2.
    commitments: [string, string];
    /// Subset of `commitments` recoverable via this wallet's FMD scan.
    ownCommitments: string[];
    /// Total value of own outputs; pending balance once FMD indexes them.
    ownInflow: bigint;
}

/// Result of `wallet.deposit`. No spent notes (escrow pulls funds via Permit2).
export interface DepositResult extends TxResultBase {
    kind: "deposit";
    /// Gross publicIn (circuit units) the depositor sent into escrow.
    sent: bigint;
    /// On-chain intent id from `MASP.submitIntent`. Absent only if the
    /// submitter path didn't surface one (relayer batch flow).
    intentId?: bigint;
}

/// Result of `wallet.transfer`. Spends 1-2 input notes; outputs are
/// `[recipientNote, changeNote]` (or `[selfA, selfB]` on self-transfer).
export interface TransferResult extends TxResultBase {
    kind: "transfer";
    spent: string[];
    inputSum: bigint;
    sent: bigint;
    change: bigint;
}

/// Result of `wallet.withdraw` / `wallet.withdrawEth`. Both outputs are
/// change-to-self; `sent` is the gross publicOut paid to the recipient.
export interface WithdrawResult extends TxResultBase {
    kind: "withdraw";
    spent: string[];
    inputSum: bigint;
    /// publicOut paid to the L1 recipient (gross, includes fee).
    sent: bigint;
    change: bigint;
}

/// Result of `wallet.swap`. Leg-1 (withdraw → wrapper) + leg-2 (B-note
/// deposit) bundled atomically; only leg-1 commitments surface here.
export interface SwapResult extends TxResultBase {
    kind: "swap";
    spent: string[];
    inputSum: bigint;
    /// publicOut leg-1 paid to the wrapper.
    sent: bigint;
    change: bigint;
    /// On-chain intent id of the leg-2 B-note deposit, if available.
    intentId?: bigint;
}

/// Discriminated union over per-tx receipt shapes. Switch on `kind`.
export type TransactionResult = DepositResult | TransferResult | WithdrawResult | SwapResult;

/// Plaintext payload of a recovered note. Cryptographic fields for
/// custom proofs against the low-level builders.
export interface WalletNotePayload {
    asset: bigint;
    value: bigint;
    rho: bigint;
    rcm: bigint;
    rcvDep: bigint;
}

/// Friendly note view returned by `wallet.notes()`.
export interface WalletNote {
    id: string;
    asset: bigint;
    value: bigint;
    spent: boolean;
    firstSeenBlock?: number;
    /// ISO-8601.
    discoveredAt: string;
    /// 0x-hex (32 bytes).
    cm: string;
    /// Decoded payload. Recomputes on each call.
    notePayload(): WalletNotePayload;
}
