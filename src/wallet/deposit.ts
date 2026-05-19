// Deposit transaction logic, extracted from `Wallet.deposit`.

import { buildDeposit } from "../bundle/deposit.js";
import { computePiHash } from "../bundle/permit2.js";
import { supportsAllowanceTransfer, supportsNativeEth } from "../chain/adapter.js";
import { decodeAddress } from "../keys/address.js";
import { freshNoteRandomness, freshOutput } from "../notes/randomness.js";
import type { DepositOptions, TransactionResult } from "./api.js";
import {
    ALLOWANCE_BUFFER_SECS,
    BPS_DENOMINATOR,
    PERMIT2_DEFAULT_DEADLINE_SECS,
    PUBLIC_IN_MAX,
} from "./constants.js";
import { DepositAdapterError, type DepositStrategy } from "./errors.js";
import { makeTransactionResult } from "./internal.js";
import type { Wallet } from "./wallet.js";
import { safePhase } from "./wallet.js";

export async function executeDeposit(
    wallet: Wallet,
    args: DepositOptions,
): Promise<TransactionResult> {
    const asset = args.asset ?? 1n;
    const recipient = decodeAddress(wallet.J, args.to ?? wallet.address);
    const payer = await wallet.cfg.chain.payerAddress();
    const assetEntry = await wallet.cfg.chain.fetchAsset(asset);
    const feeBps = await wallet.resolveFeeBps();
    if (args.amount <= 0n) {
        const { WalletConfigError } = await import("./errors.js");
        throw new WalletConfigError("deposit amount must be positive (nonzero)");
    }
    if (args.amount > PUBLIC_IN_MAX) {
        throw new Error(
            `deposit: amount ${args.amount} exceeds uint48 publicIn cap; asset ${asset} scale ${assetEntry.scale} too small`,
        );
    }
    const inAmt = args.amount * assetEntry.scale;
    const fee = (inAmt * feeBps) / BPS_DENOMINATOR;
    const total = inAmt + fee;

    const o0 = freshOutput();
    const o1 = freshNoteRandomness();
    const built = buildDeposit({
        P: wallet.P,
        J: wallet.J,
        chainId: wallet.cfg.chainId,
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

    const strategy = await pickDepositStrategy(wallet, args, payer, assetEntry.token);
    const { txHash, intentId } = await runDepositStrategy(wallet, strategy, {
        built,
        args,
        assetEntry,
        total,
    });

    return makeTransactionResult({
        kind: "deposit",
        txHash,
        built: { cm: built.cm, producedNotes: built.producedNotes },
        sent: args.amount,
        intentId,
        // Both outputs credited to depositor's own shielded address.
        ownIndices: [0, 1],
    });
}

/// Order: native ETH > AllowanceTransfer > witness (fallback).
export async function pickDepositStrategy(
    wallet: Wallet,
    args: DepositOptions,
    payer: string,
    token: string,
): Promise<DepositStrategy> {
    const chain = wallet.cfg.chain;
    if (args.asEth) {
        if (!supportsNativeEth(chain)) {
            throw new DepositAdapterError("native", ["submitIntentNative"]);
        }
        return "native";
    }
    if (supportsAllowanceTransfer(chain)) {
        const masp = await chain.maspAddress();
        const allow = await chain.permit2Allowance(token, payer, masp);
        const nowSec = Math.floor(Date.now() / 1000);
        const total = await computeDepositTotal(wallet, args, token);
        if (allow.amount >= total && allow.expiration > nowSec + ALLOWANCE_BUFFER_SECS) {
            return "allowance";
        }
    }
    if (!wallet.submitter.submitIntent && !chain.submitIntent) {
        throw new DepositAdapterError("witness", ["submitter.submitIntent | chain.submitIntent"]);
    }
    return "witness";
}

/// Every branch returns the same `{ txHash, intentId }` shape.
export async function runDepositStrategy(
    wallet: Wallet,
    strategy: DepositStrategy,
    ctx: {
        built: ReturnType<typeof buildDeposit>;
        args: DepositOptions;
        assetEntry: { token: string; scale: bigint };
        total: bigint;
    },
): Promise<{ txHash: string; intentId?: bigint }> {
    const { built, args, assetEntry, total } = ctx;
    const chain = wallet.cfg.chain;

    // `broadcast` fires once the wallet returns a tx hash (user signed,
    // tx in mempool); the awaited `tx.wait()` then resolves and we emit
    // `mined`. Splits the otherwise-opaque submit gap into three steps
    // for the form's progress UI.
    const onSent = () => safePhase(args.onPhase, "broadcast");
    const emitMined = (r: { txHash: string; intentId: bigint }) => {
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
    if (wallet.submitter.submitIntent) {
        // Relayer-broadcast path: the submitter posts to the relayer and
        // receives the hash back. Emit `broadcast` once the request
        // resolves with a hash, then `mined` after the on-chain receipt
        // surfaces upstream. For now we treat the submitter return as
        // the broadcast point.
        const r = await wallet.submitter.submitIntent({
            chainId: wallet.cfg.chainId,
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

/// Recompute the total the strategy picker compares to the allowance window.
export async function computeDepositTotal(
    wallet: Wallet,
    args: DepositOptions,
    _token: string,
): Promise<bigint> {
    const asset = args.asset ?? 1n;
    const entry = await wallet.cfg.chain.fetchAsset(asset);
    const feeBps = await wallet.resolveFeeBps();
    const inAmt = args.amount * entry.scale;
    return inAmt + (inAmt * feeBps) / BPS_DENOMINATOR;
}
