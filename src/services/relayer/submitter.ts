// Pluggable transact-bundle submitter.

import type {
    ChainToken,
    EstimateResponse,
    RelayerSubmitResponse,
} from "../../protocol/responses.js";
import type {
    SpendKind,
    SubmitSwapPayload,
    SubmitTransactPayload,
} from "../../protocol/transact.js";
import type { HttpClientOptions } from "../http/client.js";
import { RelayerClient } from "./client.js";

/**
 * Operation kinds a fee quote can be requested for.
 *
 * Extends {@link SpendKind} with swap and deposit, which have their own endpoints. A swap's gas
 * covers two legs plus the on-chain swap, so a spend estimate would under-quote it; a deposit is
 * not relayed at submit time and is priced against the later `flushBatch`. Neither is a
 * `SpendKind`: no transact payload is tagged `"swap"`, and a deposit has no transact payload.
 */
export type EstimateKind = SpendKind | "swap" | "deposit";

export interface Submitter {
    /** Spend op. The relayer attaches the matching tree_update_batch SNARK and tpi. */
    submit(payload: SubmitTransactPayload): Promise<RelayerSubmitResponse>;
    /** Atomic shielded swap. Required for `wallet.swap`. */
    submitSwap?(payload: SubmitSwapPayload): Promise<RelayerSubmitResponse>;
    /**
     * Fee this relayer charges to relay `kind`, and the assets it accepts.
     *
     * Optional: when absent the wallet builds no fee slot, which suits a relayer that subsidises
     * gas. A relayer that charges fees rejects such a submit with a 402.
     */
    estimate?(chainId: bigint, kind: EstimateKind): Promise<EstimateResponse>;
    /**
     * Assets registered on `chainId`, with their symbols, decimals and scales.
     *
     * Optional: when absent the wallet resolves assets by numeric id from the chain registry.
     */
    assets?(chainId: bigint): Promise<readonly ChainToken[]>;
    /**
     * Account the relayer offers as a swap's `refundTo` on `chainId`, for a wallet without its
     * own EVM account. Optional.
     */
    refundAddress?(chainId: bigint): Promise<string | undefined>;
    /** The `SwapWrapper` the relayer relays swaps through on `chainId`, if any. Optional. */
    swapWrapperAddress?(chainId: bigint): Promise<string | undefined>;
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

    async assets(chainId: bigint): Promise<readonly ChainToken[]> {
        return (await chainEntry(this.client, chainId))?.tokens ?? [];
    }

    async refundAddress(chainId: bigint): Promise<string | undefined> {
        return (await chainEntry(this.client, chainId))?.refundAddress;
    }

    async swapWrapperAddress(chainId: bigint): Promise<string | undefined> {
        return (await chainEntry(this.client, chainId))?.swapWrapperAddress;
    }

    estimate(chainId: bigint, kind: EstimateKind): Promise<EstimateResponse> {
        if (kind === "swap") return this.client.estimateSwap(chainId);
        if (kind === "deposit") return this.client.estimateDeposit(chainId);
        return this.client.estimateSpend(chainId, kind);
    }
}

/** `chainId`'s entry in the relayer's `/chains`, which carries its assets and accounts. */
async function chainEntry(client: RelayerClient, chainId: bigint) {
    const { chains } = await client.getChains();
    return chains.find((c) => BigInt(c.chainId) === chainId);
}
