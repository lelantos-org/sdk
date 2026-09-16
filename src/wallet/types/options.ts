// Operation options, progress phases and note-query filters.
//
// Every operation names its asset (`asset`, or `assetIn`/`assetOut`); there is no default asset.

import type {
    AssetIdLike,
    EvmAddress,
    EvmAddressLike,
    Hex32,
    ShieldedAddressLike,
} from "../../core/brand.js";
import type { Amount, AssetRef, OutAmount } from "../assets/amount.js";
import type { SelectOpts } from "../selection/index.js";
import type { SwapQuote } from "./quotes.js";
import type { DepositEscrow } from "./results.js";

/** Every field is optional; an empty filter returns every known note. */
export interface NotesFilter {
    /** Omit to read across every asset. */
    asset?: AssetIdLike | undefined;
    /** Omit to include both spent and unspent. */
    spent?: boolean | undefined;
}

// --- phases --------------------------------------------------------------------------------------

/**
 * Progress of one operation, in order. Each operation emits the subset its kind has; see
 * {@link SpendPhase} and {@link DepositPhase}.
 *
 * - `preparing`: validating, resolving assets and fees, selecting and leasing notes.
 * - `consolidating`: `autoConsolidate` is merging notes first (a nested self-spend).
 * - `proving`: building the proof.
 * - `signing`: waiting on the EOA wallet (permit, approval or transaction prompt).
 * - `submitting`: handed to the relayer (spends) or the RPC node (deposits).
 * - `broadcast`: a transaction hash is known and the SDK is waiting for its receipt (deposits).
 * - `confirmed`: mined. Spends reach it when the relayer answers, which it does only once mined.
 */
export type Phase =
    | "preparing"
    | "consolidating"
    | "proving"
    | "signing"
    | "submitting"
    | "broadcast"
    | "confirmed";

/** Phases of a transfer, withdrawal, swap or redenominate round. */
export type SpendPhase = Exclude<Phase, "signing" | "broadcast">;

/** Phases of a deposit or a deposit cancellation. */
export type DepositPhase = Exclude<Phase, "consolidating" | "proving">;

/** Phases of `setupDepositAllowance`, reported through its own `onProgress`. */
export type AllowanceSetupStep = "approving" | "signing" | "permitting";

export interface PhaseInfo {
    /** The operation's correlation id, as on its result and on any error's `context.opId`. */
    opId: string;
    /** Present from `broadcast` on (deposits) and at `confirmed` (every kind). */
    txHash?: Hex32 | undefined;
}

/**
 * One operation's correlation id, name and progress sink, as `runOp` hands it to the operation.
 * Internal: not exported from the package.
 */
export interface OpRun<P extends Phase = Phase> {
    readonly opId: string;
    /** The operation's name; a nested consolidation reports errors as `"<op>:consolidate"`. */
    readonly op: string;
    /** Report progress: updates `state().ops` and calls `onPhase`, swallowing its throws. */
    phase(phase: P, txHash?: Hex32 | undefined): void;
}

// --- shared --------------------------------------------------------------------------------------

export interface OpOptions<P extends Phase = Phase> {
    /**
     * Checked between every step; the operation then rejects with `signal.reason` as-is. An abort
     * after a spend was handed to the relayer does not unsend it: the SDK waits for the answer or
     * reports `SPEND_OUTCOME_UNKNOWN`.
     */
    signal?: AbortSignal | undefined;
    /** Progress. A throwing callback is logged and swallowed. */
    onPhase?: ((phase: P, info: PhaseInfo) => void) | undefined;
    /**
     * Unix seconds.
     * - deposit: the Permit2 signature and escrow deadline (default now + 1 h);
     * - swap: bound into the intent; the wrapper refunds after it (default a short window);
     * - transfer / withdraw: a client-side cut-off checked before submitting (`DEADLINE_PASSED`).
     */
    deadline?: bigint | undefined;
    /**
     * Correlation id for this call, 1–64 chars of `[A-Za-z0-9_:.-]`. Default: minted by the SDK.
     * Local only: it appears in results, phases, errors and logs, and is never sent to a service.
     */
    opId?: string | undefined;
}

/**
 * Selection rules a caller may set. `fee` and `tipBlock` are omitted: the SDK supplies both from
 * the quoted relayer fee and the chain tip, and a caller value would double-count or freeze them.
 */
export type SelectionOptions = Omit<SelectOpts, "fee" | "tipBlock">;

export interface SpendOptions<P extends Phase = SpendPhase> extends OpOptions<P> {
    /**
     * Asset paying the relayer. Default: the asset being spent. Another asset needs its own input
     * note and change slot, and must be quoted by the relayer (`FEE_ASSET_NOT_QUOTED`).
     */
    feeAsset?: AssetRef | undefined;
    /** Same rules `spendableMax` takes, so a predicted maximum and the spend agree. */
    selection?: SelectionOptions | undefined;
    /** On `INSUFFICIENT_COVER`, merge notes with a self-spend and retry once. Default `false`. */
    autoConsolidate?: boolean | undefined;
}

// --- deposit -------------------------------------------------------------------------------------

export interface DepositOptions extends OpOptions<DepositPhase> {
    asset: AssetRef;
    /**
     * The principal that becomes the shielded note (`publicIn`). The protocol fee is charged on top
     * and the relayer's fee is pulled alongside; `quoteDeposit` states both.
     */
    amount: Amount;
    /**
     * Asset paying the relayer's fee note. Default `asset`. Refused (`INVALID_ARGUMENT`) with
     * `native`, and for a yield asset other than `asset`; see `depositFeeAssetRefusal`.
     */
    feeAsset?: AssetRef | undefined;
    /** Shielded owner of the new note. Default: this wallet. */
    recipient?: ShieldedAddressLike | undefined;
    /** Send the native coin through `NativeAdapter`; `asset` must be the wrapped coin. */
    native?: boolean | undefined;
}

/**
 * Which escrow `cancelDeposit` reclaims: the escrow a deposit returned (its `cancelInputs` are used
 * as-is), or an id whose inputs are rebuilt from the pool's `DepositEscrowed` log. The log is
 * searched from `fromBlock`, default the tip minus the cancel delay and a margin; pass an earlier
 * block for an older escrow.
 */
export type CancelDepositTarget =
    | DepositEscrow
    | { depositId: bigint; fromBlock?: bigint | undefined };

/** One token's allowance window in a `setupDepositAllowance` run. */
export type AllowanceSetupProgress =
    | {
          step: "approving";
          status: "wallet" | "confirming";
          /** Set with `status: "confirming"`. */
          txHash?: Hex32 | undefined;
          token: EvmAddress;
          /** 1-based position among the tokens that still need an ERC-20 approval. */
          index: number;
          total: number;
      }
    | {
          step: "signing" | "permitting";
          status: "wallet" | "confirming";
          txHash?: Hex32 | undefined;
      };

/**
 * One-time Permit2 AllowanceTransfer setup, so later deposits of these assets pull with no
 * per-deposit signature (`strategy: "allowance"`).
 *
 * Runs: an ERC-20 → Permit2 approval per token still below `cap` (one prompt each), then one
 * `PermitBatch` signature and one `permit` transaction covering every token. Assets sharing a token
 * are one entry.
 */
export interface AllowanceSetupOptions {
    /** Assets whose tokens to authorise, e.g. `quote.pulls.map((p) => p.asset.id)`. */
    assets: readonly AssetRef[];
    /** Window cap in base units. Default `2^160 − 1`, which Permit2 treats as unlimited. */
    cap?: bigint | undefined;
    /** Window expiry, unix seconds. Default now + 90 days. */
    expiration?: number | undefined;
    /** Signature deadline, unix seconds. Default now + 30 min. */
    deadline?: bigint | undefined;
    signal?: AbortSignal | undefined;
    /** Fires `wallet` before each prompt, then `confirming` with the transaction hash. */
    onProgress?: ((progress: AllowanceSetupProgress) => void) | undefined;
}

// --- spends --------------------------------------------------------------------------------------

export interface TransferOptions extends SpendOptions {
    asset: AssetRef;
    /** Value of the recipient's note. */
    amount: Amount;
    recipient: ShieldedAddressLike;
}

/** Unshield to an EVM account. `native: true` unwraps through `NativeAdapter`. */
export type WithdrawOptions = SpendOptions &
    OutAmount & {
        asset: AssetRef;
        recipient: EvmAddressLike;
        native?: boolean | undefined;
    };

/** Price a swap. Assets and amount are fixed by the returned quote. */
export type QuoteSwapOptions = OutAmount & {
    assetIn: AssetRef;
    assetOut: AssetRef;
    /** Max slippage in basis points, `0..10_000`. */
    slippageBps: number;
    /** Asset the relayer fee is quoted in, for `quote.fees.relayer`. Default `assetIn`. */
    feeAsset?: AssetRef | undefined;
    signal?: AbortSignal | undefined;
};

export interface SwapOptions extends SpendOptions {
    /** From `quoteSwap`. Its assets, amount, route and `minOut` are what the proof binds. */
    quote: SwapQuote;
    /** Shielded owner of the output note. Default: this wallet. */
    recipient?: ShieldedAddressLike | undefined;
    /**
     * EVM account a failed swap refunds to, bound into the intent. Default: this wallet's EOA,
     * else the relayer's advertised refund address.
     */
    refundAddress?: EvmAddressLike | undefined;
}
