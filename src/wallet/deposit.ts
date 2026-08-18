// Deposit transaction logic. Backs `Wallet.deposit`.

import { buildDeposit } from "../bundle/deposit.js";
import { supportsAllowanceTransfer, supportsNativeEth } from "../chain/port.js";
import {
    assetId,
    branded,
    circuitAmount,
    type EvmAddress,
    type Hex32,
    type TokenAmount,
} from "../core/brand.js";
import { safePhase } from "../core/callbacks.js";
import { DepositAdapterError, type DepositStrategy, InvalidArgumentError } from "../core/errors.js";
import { applyFee, assertPublicInFits } from "../core/fees.js";
import { randomU256 } from "../core/random.js";
import { decodeAddress } from "../keys/address.js";
import { getLogger } from "../log/logger.js";
import { computePiHash } from "../protocol/abi-hash.js";
import type { DepositOptions, DepositResult } from "./api.js";
import {
    ALLOWANCE_BUFFER_SECS,
    DEFAULT_ASSET,
    PERMIT2_DEFAULT_DEADLINE_SECS,
} from "./constants.js";
import type { SpendContext } from "./context.js";
import { makeTransactionResult } from "./result-builder.js";
import { freshDepositSlots } from "./tx/steps.js";

const log = getLogger("lelantos:wallet:deposit");

export async function executeDeposit(
    ctx: SpendContext,
    args: DepositOptions,
): Promise<DepositResult> {
    // Brand at the boundary: the option type takes a plain bigint, and
    // `assetId` is what enforces the uint64 range.
    const asset = args.asset === undefined ? DEFAULT_ASSET : assetId(args.asset);
    const amount = circuitAmount(args.amount);
    const recipient = decodeAddress(ctx.J, args.to ?? ctx.address);
    const payer = await ctx.cfg.chain.payerAddress();
    const assetEntry = await ctx.cfg.chain.fetchAsset(asset);
    const feeBps = await ctx.feeBps();
    if (amount <= 0n) {
        throw new InvalidArgumentError("deposit amount must be positive (nonzero)", {
            argument: "amount",
        });
    }
    assertPublicInFits(args.amount, {
        what: "deposit amount",
        asset,
        scale: assetEntry.scale,
    });
    const inAmt = args.amount * assetEntry.scale;
    const fee = applyFee(inAmt, feeBps);
    const total = branded<TokenAmount>(inAmt + fee);

    // Strategy first: it decides who the on-chain escrow belongs to, and the
    // request is signed and digest-bound over that address. A native deposit
    // is escrowed by `NativeAdapter` — it wraps `msg.value` and the pool
    // pulls against the adapter's own allowance — so naming the sender there
    // reverts `AdapterNotPayer`.
    const strategy = await pickDepositStrategy(ctx, args, {
        payer,
        token: assetEntry.token,
        total,
    });
    const escrowPayer = strategy === "native" ? ctx.cfg.chain.nativeAdapterAddress!()! : payer;

    const { output0: o0 } = freshDepositSlots();
    const built = buildDeposit({
        P: ctx.P,
        J: ctx.J,
        chainId: ctx.cfg.chainId,
        asset,
        payerAddress: escrowPayer,
        // The depositor either way: `recipient` is the refund-side identity
        // the note is bound to, and the adapter is only the escrow's owner.
        recipientAddress: payer,
        publicIn: args.amount,
        recipient,
        output0: {
            rho: o0.rho,
            rcm: o0.rcm,
            rcv: o0.rcv,
            rcvDep: o0.rcvDep,
            aux: o0.aux,
        },
    });
    const { txHash, depositId } = await runDepositStrategy(ctx, strategy, {
        built,
        args,
        assetEntry,
        total,
    });

    // No amount: a deposit is public on chain, but the log line collates it
    // with the wallet's other operations in one searchable place.
    log.info("deposit submitted", { strategy, asset, txHash });
    return makeTransactionResult({
        kind: "deposit",
        strategy,
        txHash,
        built: { cm: [built.cm], producedNotes: built.producedNotes },
        sent: amount,
        depositId,
        // A deposit escrows exactly one leaf, credited to the depositor's own
        // shielded address.
        ownIndices: [0],
    });
}

/** Order: native ETH > AllowanceTransfer > witness (fallback). */
async function pickDepositStrategy(
    ctx: SpendContext,
    args: DepositOptions,
    /**
     * Threaded in rather than recomputed: re-deriving `total` here would cost
     * a second `fetchAsset` and `resolveFeeBps` round trip on every ERC-20
     * deposit that reaches the allowance branch.
     */
    plan: { payer: EvmAddress; token: EvmAddress; total: TokenAmount },
): Promise<DepositStrategy> {
    const chain = ctx.cfg.chain;
    if (args.asEth) {
        if (!supportsNativeEth(chain)) {
            throw new DepositAdapterError("native", ["submitDepositNative + nativeAdapterAddress"]);
        }
        return "native";
    }
    if (supportsAllowanceTransfer(chain)) {
        const masp = await chain.maspAddress();
        const allow = await chain.permit2Allowance(plan.token, plan.payer, masp);
        const nowSec = Math.floor(Date.now() / 1000);
        if (allow.amount >= plan.total && allow.expiration > nowSec + ALLOWANCE_BUFFER_SECS) {
            return "allowance";
        }
    }
    if (!ctx.submitter.submitDeposit && !chain.submitDeposit) {
        throw new DepositAdapterError("witness", ["submitter.submitDeposit | chain.submitDeposit"]);
    }
    return "witness";
}

/** Every branch returns the same `{ txHash, depositId }` shape. */
async function runDepositStrategy(
    ctx: SpendContext,
    strategy: DepositStrategy,
    plan: {
        built: ReturnType<typeof buildDeposit>;
        args: DepositOptions;
        assetEntry: { token: EvmAddress; scale: bigint };
        total: TokenAmount;
    },
): Promise<{ txHash: Hex32; depositId?: bigint }> {
    const { built, args, assetEntry, total } = plan;
    const chain = ctx.cfg.chain;

    // `broadcast` fires once the wallet returns a tx hash (tx in mempool);
    // `mined` fires after `tx.wait()` resolves.
    const onSent = () => safePhase(args.onPhase, "broadcast");
    const emitMined = (r: { txHash: Hex32; depositId: bigint }) => {
        safePhase(args.onPhase, "mined");
        return r;
    };

    if (strategy === "native") {
        safePhase(args.onPhase, "submitting");
        return chain.submitDepositNative!({
            deposit: built.deposit,
            aux: built.aux,
            value: total,
            onSent,
        }).then(emitMined);
    }
    if (strategy === "allowance") {
        safePhase(args.onPhase, "submitting");
        return chain.submitDepositAuthorized!({
            deposit: built.deposit,
            aux: built.aux,
            onSent,
        }).then(emitMined);
    }
    // witness path
    const deadline =
        args.deadline ?? BigInt(Math.floor(Date.now() / 1000) + PERMIT2_DEFAULT_DEADLINE_SECS);
    const piHash = computePiHash(built.deposit, built.aux);
    // Random, not a clock. Permit2 nonces index an unordered bitmap, so two
    // deposits within the same millisecond collided and the second reverted
    // `InvalidNonce` — and a timestamp is predictable besides. Matches what
    // `ViemChainAdapter.permit2Nonce` already does; this is the fallback for
    // adapters that do not implement it.
    const nonce = chain.permit2Nonce ? await chain.permit2Nonce() : randomU256();
    safePhase(args.onPhase, "signing");
    const permit2 = await chain.signPermit2({
        token: assetEntry.token,
        maxTotal: total,
        deadline,
        piHash,
        nonce,
    });
    safePhase(args.onPhase, "submitting");
    if (ctx.submitter.submitDeposit) {
        // Relayer path has no mempool visibility; treat the submitter
        // response as both broadcast and mined.
        const r = await ctx.submitter.submitDeposit({
            chainId: ctx.cfg.chainId,
            deposit: built.deposit,
            permit2,
            aux: built.aux,
        });
        safePhase(args.onPhase, "broadcast");
        safePhase(args.onPhase, "mined");
        return r;
    }
    return chain.submitDeposit!({ deposit: built.deposit, permit2, aux: built.aux, onSent }).then(
        emitMined,
    );
}
