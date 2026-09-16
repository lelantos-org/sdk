// What the relayer publishes about a chain (`/chains`), cached.
//
// `HttpRelayerSubmitter` answers both `assets` and `refundAddress` from one
// `/chains` read, and every swap asks for the refund address, so an uncached
// read would cost a round trip per call.

import { ttlCache } from "../core/async.js";
import type { ChainToken, EstimateResponse } from "../protocol/responses.js";
import type { EstimateKind, Submitter } from "../services/relayer/submitter.js";

/**
 * How long a `/chains` answer is reused. Registered assets and the refund
 * account change rarely; a minute bounds how stale either can be.
 */
const RELAYER_INFO_TTL_MS = 60_000;

/** The relayer's per-chain metadata, read through a TTL cache. */
export interface RelayerInfo {
    /** Registered assets, or `undefined` when the submitter cannot list them. */
    readonly tokens: (() => Promise<readonly ChainToken[]>) | undefined;
    /** The account a swap without its own EVM account refunds to, if advertised. */
    refundAddress(): Promise<string | undefined>;
    /** The `SwapWrapper` the relayer advertises, if any. */
    swapWrapperAddress(): Promise<string | undefined>;
}

export function relayerInfo(
    submitter: Submitter,
    chainId: bigint,
    ttlMs: number = RELAYER_INFO_TTL_MS,
): RelayerInfo {
    const assets = submitter.assets;
    const refund = submitter.refundAddress;
    const wrapper = submitter.swapWrapperAddress;
    return {
        tokens: assets ? ttlCache(() => assets.call(submitter, chainId), ttlMs) : undefined,
        refundAddress: refund
            ? ttlCache(() => refund.call(submitter, chainId), ttlMs)
            : async () => undefined,
        swapWrapperAddress: wrapper
            ? ttlCache(() => wrapper.call(submitter, chainId), ttlMs)
            : async () => undefined,
    };
}

/**
 * The relayer's quote for `kind`, or `undefined` when the submitter cannot quote (a custom
 * submitter without shielded-fee support).
 *
 * The one place a fee quote is requested, for spends, deposits and `quoteFee`.
 */
export function relayerEstimate(
    ctx: { readonly cfg: { readonly submitter: Submitter; readonly chainId: bigint } },
    kind: EstimateKind,
): Promise<EstimateResponse | undefined> {
    const { submitter, chainId } = ctx.cfg;
    return submitter.estimate ? submitter.estimate(chainId, kind) : Promise.resolve(undefined);
}
