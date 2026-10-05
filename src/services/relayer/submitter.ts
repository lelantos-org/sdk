// Pluggable transact-bundle submitter.

import { InvalidArgumentError } from "../../errors/config.js";
import type {
    ChainToken,
    EstimateResponse,
    RelayerSubmitResponse,
} from "../../protocol/responses.js";
import type {
    SpendKind,
    SubmitGenericPayload,
    SubmitSwapPayload,
    SubmitTransactPayload,
} from "../../protocol/transact.js";
import type { HttpClientOptions } from "../http/client.js";
import { RelayerClient } from "./client.js";

/**
 * Operation kinds a fee quote can be requested for.
 *
 * Extends {@link SpendKind} with swap, generic and deposit, which have their own endpoints: a
 * swap's gas covers two legs plus the on-chain swap, a generic execution's covers the wrapper plus
 * the gas its calls are forwarded, and a deposit is not relayed at submit time, so it is priced
 * against the later `flushBatch`.
 */
export type EstimateKind = SpendKind | "swap" | "generic" | "deposit";

/** What a fee quote depends on besides the chain and the kind. */
export interface EstimateOptions {
    /** `"generic"` only: the gas the call leg is forwarded (`GenericArgs.minGas`). Required there. */
    minGas?: bigint | undefined;
}

export interface Submitter {
    /** Spend op. The relayer attaches the matching tree_update_batch SNARK and tpi. */
    submit(payload: SubmitTransactPayload): Promise<RelayerSubmitResponse>;
    /** Atomic shielded swap. Required for `wallet.swap`. */
    submitSwap?(payload: SubmitSwapPayload): Promise<RelayerSubmitResponse>;
    /** Atomic shielded execution of arbitrary calls through `GenericCallWrapper`. */
    submitGeneric?(payload: SubmitGenericPayload): Promise<RelayerSubmitResponse>;
    /**
     * Fee this relayer charges to relay `kind`, and the assets it accepts.
     *
     * When absent the wallet builds no fee slot, which suits a relayer that subsidises gas. A
     * relayer that charges fees rejects such a submit with a 402.
     */
    estimate?(
        chainId: bigint,
        kind: EstimateKind,
        opts?: EstimateOptions,
    ): Promise<EstimateResponse>;
    /**
     * Assets registered on `chainId`, with their symbols, decimals and scales. When absent the
     * wallet resolves assets by numeric id from the chain registry.
     */
    assets?(chainId: bigint): Promise<readonly ChainToken[]>;
    /**
     * Account the relayer offers as a swap's `refundTo` on `chainId`, for a wallet without its
     * own EVM account.
     */
    refundAddress?(chainId: bigint): Promise<string | undefined>;
    /** The `SwapWrapper` the relayer relays swaps through on `chainId`, if any. */
    swapWrapperAddress?(chainId: bigint): Promise<string | undefined>;
    /** The `GenericCallWrapper` the relayer relays generic executions through, if any. */
    genericCallWrapperAddress?(chainId: bigint): Promise<string | undefined>;
}

export class HttpRelayerSubmitter implements Submitter {
    private readonly client: RelayerClient;

    constructor(baseUrl: string, opts: HttpClientOptions = {}) {
        this.client = new RelayerClient(baseUrl, opts);
    }

    submit(payload: SubmitTransactPayload): Promise<RelayerSubmitResponse> {
        return this.client.submitTransact(payload);
    }

    submitSwap(payload: SubmitSwapPayload): Promise<RelayerSubmitResponse> {
        return this.client.submitSwap(payload);
    }

    submitGeneric(payload: SubmitGenericPayload): Promise<RelayerSubmitResponse> {
        return this.client.submitGeneric(payload);
    }

    async assets(chainId: bigint): Promise<readonly ChainToken[]> {
        return (await chainEntry(this.client, chainId))?.tokens ?? [];
    }

    async refundAddress(chainId: bigint): Promise<string | undefined> {
        return (await chainEntry(this.client, chainId))?.refundAddress;
    }

    async swapWrapperAddress(chainId: bigint): Promise<string | undefined> {
        return (await chainEntry(this.client, chainId))?.swapWrapperAddress;
    }

    async genericCallWrapperAddress(chainId: bigint): Promise<string | undefined> {
        return (await chainEntry(this.client, chainId))?.genericCallWrapperAddress;
    }

    estimate(
        chainId: bigint,
        kind: EstimateKind,
        opts: EstimateOptions = {},
    ): Promise<EstimateResponse> {
        if (kind === "swap") return this.client.estimateSwap(chainId);
        if (kind === "generic") {
            if (opts.minGas === undefined) {
                throw new InvalidArgumentError("estimate: a generic quote needs `minGas`", {
                    argument: "minGas",
                });
            }
            return this.client.estimateGeneric(chainId, opts.minGas);
        }
        if (kind === "deposit") return this.client.estimateDeposit(chainId);
        return this.client.estimateSpend(chainId, kind);
    }
}

/** `chainId`'s entry in the relayer's `/chains`, which carries its assets and accounts. */
async function chainEntry(client: RelayerClient, chainId: bigint) {
    const { chains } = await client.getChains();
    return chains.find((c) => BigInt(c.chainId) === chainId);
}
