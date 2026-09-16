// Shielding: `quoteDeposit` and `deposit`. Both run `planDeposit` and `readPullStates`, so a quote
// states exactly the pulls, fees and strategy the deposit would sign over.

import { buildDeposit } from "../../bundle/deposit.js";
import {
    type ChainAdapter,
    supportsAllowanceBatch,
    supportsAllowanceTransfer,
    supportsNativeEth,
    supportsSigning,
} from "../../chain/port.js";
import type { DepositSubmitted } from "../../chain/types.js";
import {
    branded,
    type CircuitAmount,
    type EvmAddress,
    type Hex32,
    type ShieldedAddress,
    type TokenAmount,
} from "../../core/brand.js";
import { fieldToBytes32 } from "../../core/hex.js";
import { randomU256 } from "../../core/random.js";
import { unixNow } from "../../core/time.js";
import { assertNever } from "../../errors/base.js";
import {
    type DepositStrategy,
    NoEvmAccountError,
    UnsupportedOperationError,
} from "../../errors/chain.js";
import { InvalidArgumentError } from "../../errors/config.js";
import { WireFormatError } from "../../errors/network.js";
import type { DecodedAddress } from "../../keys/address.js";
import { getLogger } from "../../log/logger.js";
import { computePiHash } from "../../protocol/abi-hash.js";
import {
    type DepositPulls,
    depositFeeAssetRefusal,
    depositPulls,
} from "../../protocol/deposit-pulls.js";
import { assertPublicInFits, type DepositTotals, depositTotals } from "../../protocol/fees.js";
import {
    precheckAmount,
    publicMoney,
    requirePositive,
    resolveAmount,
    shieldedMoney,
} from "../assets/amount.js";
import type { AssetInfo } from "../assets/info.js";
import { ALLOWANCE_BUFFER_SECS, PERMIT2_DEFAULT_DEADLINE_SECS } from "../constants.js";
import type { WalletContext } from "../context.js";
import { assertBeforeDeadline, checkDeadlineArg, deadlineOrDefault } from "../tx/deadline.js";
import {
    type DepositFee,
    depositProtocolFee,
    depositSlots,
    resolveDepositFees,
} from "../tx/deposit-fee.js";
import { cancelInputsOf, isNativeEscrowPayer } from "../tx/escrow.js";
import { shieldedRecipient } from "../tx/recipient.js";
import { outputCommitments } from "../tx/result-builder.js";
import type { DepositOptions, DepositPhase, OpRun } from "../types/options.js";
import type { DepositPull, DepositQuote, TokenAllowanceState } from "../types/quotes.js";
import type { DepositEscrow, DepositResult, FeeBreakdown, Money } from "../types/results.js";

const log = getLogger("lelantos:wallet:deposit");

/**
 * Upper bound of the pool's `cancelDelay` (`MASP.setCancelDelay` accepts `[3600, 50400]`), used for
 * `cancellableAtBlock` when the adapter cannot read the live delay: never earlier than the truth.
 */
const CANCEL_DELAY_BOUND = 50_400;

/** Everything a deposit is sized and signed from, before any account state is read. */
interface DepositPlan {
    readonly asset: AssetInfo;
    readonly feeAsset: AssetInfo;
    readonly native: boolean;
    /** The principal, `publicIn`. */
    readonly amount: CircuitAmount;
    readonly recipient: ShieldedAddress;
    readonly decodedRecipient: DecodedAddress;
    readonly relayerFee: DepositFee;
    readonly totals: DepositTotals;
    /** What the pool pulls. */
    readonly pulls: DepositPulls<AssetInfo>;
    /** The same pulls sized as the ceilings signed and checked against allowances. */
    readonly ceilings: DepositPulls<AssetInfo>;
    readonly fees: FeeBreakdown;
    /** The caller's deadline, validated; `undefined` for the default. */
    readonly deadline: bigint | undefined;
}

/**
 * Validate and price a deposit: every refusal `deposit` makes before signing, in the same order.
 *
 * @throws {InvalidArgumentError} for a bad amount, recipient, deadline or a refused fee asset.
 * @throws {NoEvmAccountError} when the chain layer cannot sign.
 * @throws {UnsupportedOperationError} for `native` without `NativeAdapter`.
 * @throws {FeeAssetNotQuotedError} when the relayer charges but quotes nothing in the fee asset.
 */
async function planDeposit(
    ctx: WalletContext,
    args: DepositOptions,
    op: "deposit" | "quoteDeposit",
): Promise<DepositPlan> {
    // Before any I/O: a bad argument should not cost chain reads to report.
    precheckAmount(args.amount, "amount", op);
    const deadline = checkDeadlineArg(args.deadline);
    if (args.native !== undefined && typeof args.native !== "boolean") {
        throw new InvalidArgumentError(`${op}: native must be a boolean`, { argument: "native" });
    }
    const native = args.native === true;
    const chain = ctx.cfg.chain;
    if (!supportsSigning(chain)) throw new NoEvmAccountError({ operation: "deposit" });
    if (native && !supportsNativeEth(chain)) {
        throw new UnsupportedOperationError("deposit:native", [
            "chain.submitDepositNative",
            "nativeAdapterAddress",
        ]);
    }
    const recipient = shieldedRecipient(ctx.J, args.recipient ?? ctx.address, op);

    // Verified: token, scale, fee rate and yield state are signed over and pulled, so they come
    // from the pool, never the relayer's list.
    const asset = await ctx.assets.resolveVerified(args.asset);
    const amount = resolveAmount(args.amount, asset);
    requirePositive(amount, "amount", op);
    const feeAsset =
        args.feeAsset === undefined ? asset : await ctx.assets.resolveVerified(args.feeAsset);
    assertDepositFeeAsset(asset, feeAsset, native);
    assertPublicInFits(amount, { what: "deposit amount", asset: asset.id, scale: asset.scale });

    // The relayer is paid with a note minted alongside the depositor's, so the payer funds it
    // too: principal, protocol fee and relayer note are all pulled, and the signed ceilings must
    // cover them or Permit2 refuses the transfer.
    const [relayerFee] = (await resolveDepositFees(ctx, [feeAsset.id])) as [DepositFee];
    assertPublicInFits(relayerFee.value, {
        what: "deposit relayer fee",
        asset: feeAsset.id,
        scale: feeAsset.scale,
    });
    // The deposit rate is charged on top of the principal. A yield asset is priced from the
    // pool's `gross / supply`, so this throws when the source has not reported it.
    const totals = depositTotals({
        publicIn: amount,
        feeIn: relayerFee.value,
        depositBps: asset.depositBps,
        scale: asset.scale,
        yieldEnabled: asset.yieldEnabled,
        rate: asset.rate,
        publicAssetId: asset.id,
        feeAssetId: feeAsset.id,
        feeScale: feeAsset.scale,
    });
    const pullArgs = {
        deposited: asset,
        feeAsset,
        principal: totals.principal,
        relayer: totals.relayer,
    };
    return {
        asset,
        feeAsset,
        native,
        amount,
        recipient: recipient.address,
        decodedRecipient: recipient.decoded,
        relayerFee,
        totals,
        pulls: depositPulls(pullArgs),
        // The fee asset of a separate pull is plain (`assertDepositFeeAsset`), so only the
        // principal's pull gets headroom.
        ceilings: depositPulls({ ...pullArgs, ceiling: true }),
        fees: Object.freeze({
            protocol: depositProtocolFee(asset, amount),
            // The note's value is exact; its pull is `depositTotals.relayer`.
            relayer:
                relayerFee.value > 0n
                    ? Object.freeze({
                          asset: feeAsset.id,
                          amount: relayerFee.value,
                          baseUnits: totals.relayer,
                      })
                    : null,
        }),
        deadline,
    };
}

/**
 * Refuse a fee asset the pool would refuse, before the relayer is asked for a quote or anything is
 * signed. The rule is `depositFeeAssetRefusal`'s.
 */
function assertDepositFeeAsset(asset: AssetInfo, feeAsset: AssetInfo, native: boolean): void {
    const refusal = depositFeeAssetRefusal(asset, feeAsset, native);
    if (refusal === undefined) return;
    if (refusal === "native-deposit") {
        throw new InvalidArgumentError(
            `a native deposit pays the relayer in the wrapped coin (asset ${asset.id}); ` +
                `feeAsset ${feeAsset.id} needs an ERC-20 deposit`,
            { argument: "feeAsset" },
        );
    }
    if (refusal !== "yield-fee-asset") assertNever(refusal, "deposit fee asset refusal");
    throw new InvalidArgumentError(
        `asset ${feeAsset.id} earns yield, so it can pay a deposit's relayer fee only ` +
            `when it is also the deposited asset (${asset.id})`,
        { argument: "feeAsset" },
    );
}

// --- account state and strategy ------------------------------------------------------------------

/**
 * Whether a token's Permit2 state lets the pool pull `pull` on the allowance path: the window
 * covers the signed ceiling and outlives the buffer, and the ERC-20 approval covers the pull.
 *
 * The single predicate `deposit` chooses its strategy by and `DepositQuote.pulls[].allowance.covers`
 * reports.
 */
function allowanceCovers(
    state: { erc20: bigint; window: { amount: bigint; expiration: number } },
    pull: { amount: bigint; ceiling: bigint },
    nowSecs: number = unixNow(),
): boolean {
    return (
        state.window.amount >= pull.ceiling &&
        state.window.expiration > nowSecs + ALLOWANCE_BUFFER_SECS &&
        state.erc20 >= pull.amount
    );
}

/** One token's pull with the account state read for it. */
interface PullState {
    asset: AssetInfo;
    token: EvmAddress;
    amount: TokenAmount;
    ceiling: TokenAmount;
    balance: TokenAmount | undefined;
    allowance: TokenAllowanceState | undefined;
}

/**
 * Read, per token the deposit pulls, the payer's allowances (not on the native path) and, when
 * asked, its balance. A figure the adapter cannot read is `undefined`; a failed read rejects.
 */
async function readPullStates(
    chain: ChainAdapter,
    plan: DepositPlan,
    payer: EvmAddress,
    opts: { balances: boolean },
): Promise<PullState[]> {
    const now = unixNow();
    const allowanceReads =
        !plan.native &&
        supportsAllowanceTransfer(chain) &&
        typeof chain.tokenAllowance === "function" &&
        typeof chain.permit2Address === "function";
    const masp = allowanceReads ? await chain.maspAddress() : undefined;
    return Promise.all(
        plan.pulls.byToken.map(async (pull, i): Promise<PullState> => {
            const ceiling = plan.ceilings.byToken[i]!.amount;
            const token = pull.asset.token;
            const [balance, allowance] = await Promise.all([
                opts.balances ? readBalance(chain, plan.native, token, payer) : undefined,
                allowanceReads
                    ? readAllowance(chain as AllowanceReader, token, payer, masp!).then(
                          (s): TokenAllowanceState =>
                              Object.freeze({
                                  ...s,
                                  covers: allowanceCovers(s, { amount: pull.amount, ceiling }, now),
                              }),
                      )
                    : undefined,
            ]);
            return { asset: pull.asset, token, amount: pull.amount, ceiling, balance, allowance };
        }),
    );
}

type AllowanceReader = ChainAdapter &
    Required<Pick<ChainAdapter, "permit2Allowance" | "tokenAllowance" | "permit2Address">>;

async function readAllowance(
    chain: AllowanceReader,
    token: EvmAddress,
    payer: EvmAddress,
    masp: EvmAddress,
): Promise<Omit<TokenAllowanceState, "covers">> {
    const [erc20, window] = await Promise.all([
        chain.tokenAllowance(token, payer, chain.permit2Address()),
        chain.permit2Allowance(token, payer, masp),
    ]);
    return {
        erc20,
        window: Object.freeze({
            amount: window.amount,
            expiration: window.expiration,
            nonce: window.nonce,
        }),
    };
}

async function readBalance(
    chain: ChainAdapter,
    native: boolean,
    token: EvmAddress,
    payer: EvmAddress,
): Promise<TokenAmount | undefined> {
    if (native) {
        return chain.nativeBalance
            ? branded<TokenAmount>(await chain.nativeBalance(payer))
            : undefined;
    }
    return chain.tokenBalanceOf ? chain.tokenBalanceOf(token, payer) : undefined;
}

/**
 * Order: native > AllowanceTransfer > witness.
 *
 * The allowance path is taken only when every token the deposit pulls is covered
 * ({@link allowanceCovers}); a window for the deposit token alone does not pay a relayer note in
 * another token, and such a payer falls back to the witness path, which signs both pulls at once.
 */
function strategyFor(
    chain: ChainAdapter,
    native: boolean,
    pulls: readonly PullState[],
): DepositStrategy {
    if (native) return "native";
    if (pulls.length > 0 && pulls.every((p) => p.allowance?.covers === true)) return "allowance";
    if (!chain.submitDeposit) {
        throw new UnsupportedOperationError("deposit:witness", ["chain.submitDeposit"]);
    }
    return "witness";
}

// --- quote ---------------------------------------------------------------------------------------

/** `wallet.quoteDeposit`: what `deposit(args)` would pull, charge and do right now. */
export async function quoteDeposit(
    ctx: WalletContext,
    args: DepositOptions,
): Promise<DepositQuote> {
    const plan = await planDeposit(ctx, args, "quoteDeposit");
    const chain = ctx.cfg.chain as ChainAdapter;
    args.signal?.throwIfAborted();
    const payer = await chain.payerAddress();
    const states = await readPullStates(chain, plan, payer, { balances: true });
    args.signal?.throwIfAborted();
    const strategy = strategyFor(chain, plan.native, states);
    const pulls: DepositPull[] = states.map((s) => Object.freeze({ ...s }));
    const canSetUp =
        !plan.native &&
        supportsAllowanceBatch(chain) &&
        typeof chain.tokenAllowance === "function" &&
        typeof chain.tokenApprove === "function" &&
        typeof chain.permit2Address === "function";
    return Object.freeze({
        kind: "depositQuote" as const,
        asset: plan.asset,
        feeAsset: plan.feeAsset,
        native: plan.native,
        amount: shieldedMoney(plan.asset, plan.amount),
        fees: plan.fees,
        principal: plan.totals.principal,
        pulls: Object.freeze(pulls) as DepositPull[],
        separateFee: plan.pulls.separateFee !== undefined,
        feeSharesToken: plan.pulls.feeSharesToken,
        strategy,
        allowanceSetupAvailable: canSetUp && pulls.some((p) => p.allowance?.covers !== true),
        sufficientBalance: pulls.every((p) => p.balance !== undefined)
            ? pulls.every((p) => (p.balance as bigint) >= p.amount)
            : undefined,
        quotedAt: unixNow(),
    });
}

// --- execute -------------------------------------------------------------------------------------

/** `wallet.deposit`: escrow `amount` of `asset` for the relayer to flush into the tree. */
export async function executeDeposit(
    ctx: WalletContext,
    args: DepositOptions,
    run: OpRun<DepositPhase> = { opId: "deposit", op: "deposit", phase: () => undefined },
): Promise<DepositResult> {
    run.phase("preparing");
    const plan = await planDeposit(ctx, args, "deposit");
    const chain = ctx.cfg.chain as ChainAdapter;
    const { signal } = args;
    signal?.throwIfAborted();
    const payer = await chain.payerAddress();
    // Allowances only: the strategy needs them, the balance is the chain's to refuse.
    const states = await readPullStates(chain, plan, payer, { balances: false });
    const strategy = strategyFor(chain, plan.native, states);
    // Read before sending, so a failed read cannot hide a deposit that landed.
    const cancelDelay = chain.cancelDelay ? await chain.cancelDelay() : CANCEL_DELAY_BOUND;
    const deadline = deadlineOrDefault(plan.deadline, PERMIT2_DEFAULT_DEADLINE_SECS);
    assertBeforeDeadline(deadline);
    signal?.throwIfAborted();

    // A native deposit is escrowed by `NativeAdapter` (it wraps `msg.value` and the pool pulls
    // against its allowance), so naming the sender there reverts `AdapterNotPayer`.
    const escrowPayer = strategy === "native" ? chain.nativeAdapterAddress!()! : payer;
    const built = buildDeposit({
        P: ctx.P,
        J: ctx.J,
        chainId: ctx.cfg.chainId,
        asset: plan.asset.id,
        payerAddress: escrowPayer,
        // Always the depositor: the refund-side identity the note is bound to.
        recipientAddress: payer,
        publicIn: plan.amount,
        recipient: plan.decodedRecipient,
        ...depositSlots(plan.relayerFee),
    });

    const submit = {
        deposit: built.deposit,
        aux: built.aux,
        feeAux: built.feeAux,
        onSent: (txHash: Hex32) => run.phase("broadcast", txHash),
    };
    const principal = plan.ceilings.byAsset[0]!;
    const fee = plan.ceilings.byAsset[1];
    let submitted: DepositSubmitted;
    if (strategy === "native") {
        run.phase("submitting");
        // `assertDepositFeeAsset` keeps a native deposit on one token, so the principal's ceiling
        // is the whole `msg.value`; the adapter refunds what the pool does not pull.
        submitted = await chain.submitDepositNative!({ ...submit, value: principal.amount });
    } else if (strategy === "allowance") {
        run.phase("submitting");
        submitted = await chain.submitDepositAuthorized!(submit);
    } else {
        if (strategy !== "witness") assertNever(strategy, "deposit strategy");
        const piHash = computePiHash(built.deposit, built.aux, built.feeAux);
        // Random, not time-based: Permit2 nonces index an unordered bitmap.
        const nonce = chain.permit2Nonce ? await chain.permit2Nonce() : randomU256();
        run.phase("signing");
        const permit2 = await chain.signPermit2({
            token: principal.asset.token,
            maxTotal: principal.amount,
            // Present exactly when the pool takes the two-token path.
            ...(fee ? { feeToken: fee.asset.token, maxFee: fee.amount } : {}),
            deadline,
            piHash,
            nonce,
        });
        signal?.throwIfAborted();
        assertBeforeDeadline(deadline);
        run.phase("submitting");
        submitted = await chain.submitDeposit!({ ...submit, permit2 });
    }
    run.phase("confirmed", submitted.txHash);

    const commitment = fieldToBytes32(built.cm);
    const escrow = escrowOf(submitted, commitment, plan, cancelDelay, chain);
    // The amount is omitted from the log.
    log.info("deposit escrowed", {
        strategy,
        asset: plan.asset.id,
        feeAsset: plan.feeAsset.id,
        txHash: submitted.txHash,
    });
    // One leaf is the depositor's note; it is this wallet's only when addressed to it.
    const own = plan.recipient === ctx.address.toLowerCase() ? [0] : [];
    const { ownInflow: _, ...commitments } = outputCommitments(
        { cm: [built.cm], producedNotes: built.producedNotes },
        own,
    );
    return Object.freeze({
        kind: "deposit" as const,
        opId: run.opId,
        asset: plan.asset,
        txHash: submitted.txHash,
        ...commitments,
        fees: plan.fees,
        amount: shieldedMoney(plan.asset, plan.amount),
        strategy,
        native: plan.native,
        recipient: plan.recipient,
        pulled: Object.freeze(
            plan.pulls.byAsset.map((p) => publicMoney(p.asset, p.amount)),
        ) as Money[],
        escrow,
    });
}

/** The escrow as plain data, its cancel inputs straight from the pool's log. */
function escrowOf(
    submitted: DepositSubmitted,
    commitment: Hex32,
    plan: DepositPlan,
    cancelDelay: number,
    chain: ChainAdapter,
): DepositEscrow {
    const e = submitted.escrowed;
    if (e.cm.toLowerCase() !== commitment.toLowerCase() || e.id !== submitted.depositId) {
        throw new WireFormatError(
            "$.escrowed",
            "the chain adapter reported a DepositEscrowed payload for another deposit",
            { details: { txHash: submitted.txHash } },
        );
    }
    return Object.freeze({
        depositId: e.id,
        native: plan.native || isNativeEscrowPayer(chain, e.payer),
        asset: plan.asset.id,
        commitment,
        cancelInputs: cancelInputsOf(e),
        cancellableAtBlock: e.submittedAt + cancelDelay,
    });
}
