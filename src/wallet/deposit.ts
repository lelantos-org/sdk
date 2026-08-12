// Deposit transaction logic. Backs `Wallet.deposit`.

import { buildDeposit } from "../bundle/deposit.js";
import { supportsAllowanceTransfer, supportsNativeEth } from "../chain/port.js";
import { branded, type EvmAddress, type Hex32, type TokenAmount } from "../core/brand.js";
import { safePhase } from "../core/callbacks.js";
import { DepositAdapterError, type DepositStrategy, InvalidArgumentError } from "../core/errors.js";
import { applyFee, assertPublicInFits } from "../core/fees.js";
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
import { makeTransactionResult } from "./internal.js";
import { freshDepositSlots } from "./tx/steps.js";

const log = getLogger("lelantos:wallet:deposit");

export async function executeDeposit(
    ctx: SpendContext,
    args: DepositOptions,
): Promise<DepositResult> {
    const asset = args.asset ?? DEFAULT_ASSET;
    const recipient = decodeAddress(ctx.J, args.to ?? ctx.address);
    const payer = await ctx.cfg.chain.payerAddress();
    const assetEntry = await ctx.cfg.chain.fetchAsset(asset);
    const feeBps = await ctx.feeBps();
    if (args.amount <= 0n) {
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

    const { output0: o0, output1Pad: o1 } = freshDepositSlots();
    const built = buildDeposit({
        P: ctx.P,
        J: ctx.J,
        chainId: ctx.cfg.chainId,
        asset,
        payerAddress: payer,
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
        output1Pad: {
            rho: o1.rho,
            rcm: o1.rcm,
            rcv: o1.rcv,
            rcvDep: o1.rcvDep,
        },
    });

    const strategy = await pickDepositStrategy(ctx, args, {
        payer,
        token: assetEntry.token,
        total,
    });
    const { txHash, intentId } = await runDepositStrategy(ctx, strategy, {
        built,
        args,
        assetEntry,
        total,
    });

    log.info("deposit submitted", { strategy, asset, amount: args.amount, txHash });
    return makeTransactionResult({
        kind: "deposit",
        strategy,
        txHash,
        built: { cm: built.cm, producedNotes: built.producedNotes },
        sent: args.amount,
        intentId,
        // Both outputs credited to the depositor's own shielded address.
        // Always two: `MASP.submitIntent` escrows a fixed pair of leaves,
        // whatever arity the transact circuit has.
        ownIndices: [0, 1],
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
            throw new DepositAdapterError("native", ["submitIntentNative"]);
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
    if (!ctx.submitter.submitIntent && !chain.submitIntent) {
        throw new DepositAdapterError("witness", ["submitter.submitIntent | chain.submitIntent"]);
    }
    return "witness";
}

/** Every branch returns the same `{ txHash, intentId }` shape. */
async function runDepositStrategy(
    ctx: SpendContext,
    strategy: DepositStrategy,
    plan: {
        built: ReturnType<typeof buildDeposit>;
        args: DepositOptions;
        assetEntry: { token: EvmAddress; scale: bigint };
        total: TokenAmount;
    },
): Promise<{ txHash: Hex32; intentId?: bigint }> {
    const { built, args, assetEntry, total } = plan;
    const chain = ctx.cfg.chain;

    // `broadcast` fires once the wallet returns a tx hash (tx in mempool);
    // `mined` fires after `tx.wait()` resolves.
    const onSent = () => safePhase(args.onPhase, "broadcast");
    const emitMined = (r: { txHash: Hex32; intentId: bigint }) => {
        safePhase(args.onPhase, "mined");
        return r;
    };

    if (strategy === "native") {
        safePhase(args.onPhase, "submitting");
        return chain.submitIntentNative!({
            intent: built.intent,
            aux: built.aux,
            value: total,
            onSent,
        }).then(emitMined);
    }
    if (strategy === "allowance") {
        safePhase(args.onPhase, "submitting");
        return chain.submitIntentAuthorized!({
            intent: built.intent,
            aux: built.aux,
            onSent,
        }).then(emitMined);
    }
    // witness path
    const deadline =
        args.deadline ?? BigInt(Math.floor(Date.now() / 1000) + PERMIT2_DEFAULT_DEADLINE_SECS);
    const piHash = computePiHash(built.intent, built.aux);
    const nonce = chain.permit2Nonce ? await chain.permit2Nonce() : BigInt(Date.now());
    safePhase(args.onPhase, "signing");
    const permit2 = await chain.signPermit2({
        token: assetEntry.token,
        maxTotal: total,
        deadline,
        piHash,
        nonce,
    });
    safePhase(args.onPhase, "submitting");
    if (ctx.submitter.submitIntent) {
        // Relayer path has no mempool visibility; treat the submitter
        // response as both broadcast and mined.
        const r = await ctx.submitter.submitIntent({
            chainId: ctx.cfg.chainId,
            intent: built.intent,
            permit2,
            aux: built.aux,
        });
        safePhase(args.onPhase, "broadcast");
        safePhase(args.onPhase, "mined");
        return r;
    }
    return chain.submitIntent!({ intent: built.intent, permit2, aux: built.aux, onSent }).then(
        emitMined,
    );
}
