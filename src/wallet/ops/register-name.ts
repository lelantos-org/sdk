// Register a handle in `LelantosNameRegistrar` from shielded funds. Backs `wallet.registerName`.
//
// One `GenericCallWrapper` execution: unshield the registrar's fee plus the smallest change the
// pool will re-shield, approve the fee and register from the wrapper's single-use clone, re-shield
// the change. No EVM account of the user's takes part or is named, so nothing public links the
// handle to one: the registrant is the clone, and the handle belongs to the account's controller
// key (`keys/name-controller.ts`).
//
// The value registered is the account's published address, the one at
// `PUBLISHED_DIVERSIFIER_INDEX`, which the wallet hands out nowhere else.

import type { ChainReader } from "../../chain/port.js";
import type { NameFee } from "../../chain/types.js";
import {
    encodeApprove,
    encodeRegisterName,
    handleRegisteredIn,
} from "../../chain/viem/name-calls.js";
import {
    type EvmAddress,
    evmAddress,
    type Hex32,
    type ShieldedAddress,
    type TokenAmount,
} from "../../core/brand.js";
import { UnsupportedOperationError } from "../../errors/chain.js";
import { InvalidArgumentError } from "../../errors/config.js";
import { PUBLISHED_DIVERSIFIER_INDEX } from "../../keys/diversifier.js";
import { addressFromViewingKey } from "../../keys/keys.js";
import { deriveNameControllerKey } from "../../keys/name-controller.js";
import { depositTotal } from "../../protocol/fees.js";
import { parseHandle } from "../../protocol/names.js";
import type { GenericCall } from "../../protocol/transact.js";
import {
    chargedMoney,
    publicMoney,
    type ResolvedOutAmount,
    resolveOutAmount,
    shieldedMoney,
} from "../assets/amount.js";
import type { AssetInfo } from "../assets/info.js";
import { REGISTER_NAME_MIN_GAS } from "../constants.js";
import type { WalletContext } from "../context.js";
import { resolveDepositFees } from "../tx/deposit-fee.js";
import { executeGenericCall } from "../tx/generic-call.js";
import { detachedRun, type SpendRun } from "../tx/run-spend.js";
import type { RegisterNameOptions } from "../types/options.js";
import type { RegisterNameResult } from "../types/results.js";

const OP = "registerName";

export async function executeRegisterName(
    ctx: WalletContext,
    args: RegisterNameOptions,
    run: SpendRun = detachedRun(OP),
): Promise<RegisterNameResult> {
    // A name under a parent is refused: the registrar holds bare labels.
    const { label } = parseHandle(args.label);
    const { registrar, fee } = await openRegistration(ctx, label);
    const asset = await fundingAsset(ctx, args.asset, fee);
    const out = await smallestUnshield(ctx, asset, fee.amount);

    const controller = deriveNameControllerKey(ctx.keys.nsk).address;
    const address = addressFromViewingKey(ctx.P, ctx.J, ctx.keys, PUBLISHED_DIVERSIFIER_INDEX);

    const res = await executeGenericCall(
        ctx,
        {
            op: OP,
            asset,
            out,
            calls: registrationCalls(registrar, fee, { label, address, controller }),
            outputs: [
                {
                    asset,
                    tokens: (out.net - fee.amount) as TokenAmount,
                    sizing: "exact",
                    recipient: ctx.ownAddress,
                },
            ],
            minGas: REGISTER_NAME_MIN_GAS,
            // Both are public in the same transaction as the address. The controller is already
            // named there and nothing links it to the user, unlike the wallet's EVM account.
            refundTo: controller,
            surplusTo: controller,
            deadline: args.deadline,
        },
        args,
        run,
    );

    const { outputCommitments, outputCredits, refundCredit, protocolFee, relayerFee, ...base } =
        res;
    return Object.freeze({
        kind: "registerName" as const,
        ...base,
        fees: { protocol: chargedMoney(publicMoney(asset, protocolFee)), relayer: relayerFee },
        label,
        address,
        controller,
        registrationFee: chargedMoney(publicMoney(asset, fee.amount)),
        registered: await registeredBy(ctx.cfg.chain, res.txHash, { registrar, label, controller }),
        changeCommitment: outputCommitments[0] as Hex32,
        changeCredit: shieldedMoney(asset, outputCredits[0] ?? 0n),
        refundCredit: shieldedMoney(asset, refundCredit),
    });
}

/**
 * The registrar and its fee, once `label` is known to be free.
 *
 * Availability is checked before anything is proven: a registration of a taken label only refunds,
 * and the relayer's fee is spent either way.
 */
async function openRegistration(
    ctx: Pick<WalletContext, "cfg">,
    label: string,
): Promise<{ registrar: EvmAddress; fee: NameFee }> {
    const { chain, nameRegistrarAddress } = ctx.cfg;
    if (!nameRegistrarAddress) {
        throw new UnsupportedOperationError(OP, [
            "a LelantosNameRegistrar address (`nameRegistrarAddress` in the network preset)",
        ]);
    }
    if (!chain.nameFee || !chain.nameAvailable) {
        throw new UnsupportedOperationError(OP, ["chain.nameFee", "chain.nameAvailable"]);
    }
    const registrar = evmAddress(nameRegistrarAddress);
    const [fee, available] = await Promise.all([
        chain.nameFee(registrar),
        chain.nameAvailable(registrar, label),
    ]);
    if (!available) {
        throw new InvalidArgumentError(`${OP}: "${label}" is already registered`, {
            argument: "label",
            details: { reason: "taken" },
        });
    }
    return { registrar, fee };
}

/**
 * The asset the registration unshields: a plain pool asset of the registrar's fee token. `named`
 * is the caller's choice; without it the asset is looked up from the token, which needs an asset
 * list a deployment may not serve to the wallet.
 */
async function fundingAsset(
    ctx: Pick<WalletContext, "assets">,
    named: RegisterNameOptions["asset"],
    fee: NameFee,
): Promise<AssetInfo> {
    const free = fee.amount === 0n;
    if (named === undefined && free) {
        throw new InvalidArgumentError(
            `${OP}: registration is free on this chain, so name the \`asset\` to unshield the change from`,
            { argument: "asset" },
        );
    }
    const asset =
        named === undefined
            ? await assetOfToken(ctx, fee.token)
            : await ctx.assets.resolveVerified(named);
    if (!free && asset.token.toLowerCase() !== fee.token.toLowerCase()) {
        throw new InvalidArgumentError(
            `${OP}: the registrar charges its fee in ${fee.token}, which is not the token of asset ${asset.id}`,
            { argument: "asset" },
        );
    }
    if (asset.yieldEnabled) {
        throw new InvalidArgumentError(
            `${OP}: asset ${asset.id} earns yield and cannot be re-shielded by the wrapper; name a plain asset of the same token`,
            { argument: "asset" },
        );
    }
    return asset;
}

async function assetOfToken(
    ctx: Pick<WalletContext, "assets">,
    token: EvmAddress,
): Promise<AssetInfo> {
    try {
        return await ctx.assets.resolveVerified(token);
    } catch (err) {
        if (!(err instanceof InvalidArgumentError)) throw err;
        throw new InvalidArgumentError(
            `${OP}: the registrar charges its fee in ${token}, which this wallet cannot map to a pool asset; pass \`asset\``,
            { argument: "asset", cause: err },
        );
    }
}

/**
 * Leg 1 for a registration: the fee plus the pull of a one-unit change note, the least the pool
 * re-shields. Whatever is re-shielded is re-shielded next to the published address, in public.
 */
async function smallestUnshield(
    ctx: Pick<WalletContext, "J" | "cfg">,
    asset: AssetInfo,
    fee: bigint,
): Promise<ResolvedOutAmount> {
    const [flush] = await resolveDepositFees(ctx, [asset.id]);
    const change = depositTotal({
        publicIn: 1n,
        feeIn: flush?.value ?? 0n,
        depositBps: asset.depositBps,
        scale: asset.scale,
    });
    return resolveOutAmount({ net: { baseUnits: fee + change } }, asset, OP);
}

/**
 * The clone's calls: approve the fee, then register. The approval is exactly the fee read before
 * proving, so a fee raised since makes the pull fail and the execution refund.
 */
function registrationCalls(
    registrar: EvmAddress,
    fee: NameFee,
    handle: { label: string; address: ShieldedAddress; controller: EvmAddress },
): GenericCall[] {
    const register: GenericCall = {
        target: registrar,
        value: 0n,
        data: encodeRegisterName(handle.label, handle.address, handle.controller),
    };
    if (fee.amount === 0n) return [register];
    return [{ target: fee.token, value: 0n, data: encodeApprove(registrar, fee.amount) }, register];
}

/**
 * Whether the transaction registered the handle, read from its own receipt. `undefined` when the
 * receipt could not be read.
 */
async function registeredBy(
    chain: ChainReader,
    txHash: Hex32,
    registration: { registrar: EvmAddress; label: string; controller: EvmAddress },
): Promise<boolean | undefined> {
    if (!chain.txReceiptLogs) return undefined;
    try {
        return handleRegisteredIn(await chain.txReceiptLogs(txHash), registration);
    } catch {
        return undefined;
    }
}
