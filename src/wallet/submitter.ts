// Pluggable transact-bundle submitter.

import type { HttpClientOptions } from "../core/http.js";
import type {
    ChainToken,
    EstimateResponse,
    RelayerDepositResponse,
    RelayerSubmitResponse,
} from "../protocol/responses.js";
import type {
    SpendKind,
    SubmitDepositPayload,
    SubmitSwapPayload,
    SubmitTransactPayload,
} from "../protocol/transact.js";
import { RelayerClient } from "../services/relayer/client.js";

/**
 * What a fee quote can be asked about.
 *
 * Wider than {@link SpendKind} because a swap and a deposit are quoted too, on
 * their own endpoints. A swap's gas covers two legs plus the on-chain swap, so
 * a spend estimate would under-quote it; a deposit is not relayed at all at
 * submit time and is priced against the later `flushBatch`.
 *
 * Neither is a `SpendKind`: no single transact payload is tagged `"swap"`, and
 * a deposit carries no transact payload whatsoever.
 */
export type EstimateKind = SpendKind | "swap" | "deposit";

export interface Submitter {
    /** Spend op. Relayer attaches the matching tree_update_batch SNARK + tpi. */
    submit(payload: SubmitTransactPayload): Promise<RelayerSubmitResponse>;
    /**
     * Deposit escrow, for a relayer that broadcasts on the wallet's behalf.
     * Absent on `HttpRelayerSubmitter`, so the default wiring falls back to
     * `chain.submitDeposit`. Encode the body with `serializeSubmitDeposit`
     * from `@lelantos-org/sdk/relayer`.
     */
    submitDeposit?(payload: SubmitDepositPayload): Promise<RelayerDepositResponse>;
    /** Atomic shielded swap. Required for `Wallet.swap`. */
    submitSwap?(payload: SubmitSwapPayload): Promise<RelayerSubmitResponse>;
    /**
     * What this relayer will charge to relay `kind`, and which assets it takes.
     *
     * Optional so a submitter written before shielded fees existed keeps
     * working: absent means the wallet builds no fee slot, which is correct for
     * a relayer that subsidises gas and is the behaviour that predates this. A
     * relayer that *does* charge and is spoken to through such a submitter
     * answers the submit with a 402 instead — the same failure as before.
     */
    estimate?(chainId: bigint, kind: EstimateKind): Promise<EstimateResponse>;
    /**
     * Assets registered on `chainId`, with their symbols, decimals and scales.
     *
     * Optional for the same reason as `estimate`: a submitter written before
     * this existed keeps working, and a wallet without one resolves assets by
     * numeric id off the chain registry, exactly as it did before.
     */
    assets?(chainId: bigint): Promise<readonly ChainToken[]>;
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

    /**
     * `/chains` carries every registered asset, so the wallet's registry costs
     * no extra round trip beyond the one a caller would make anyway.
     */
    async assets(chainId: bigint): Promise<readonly ChainToken[]> {
        const { chains } = await this.client.getChains();
        return chains.find((c) => BigInt(c.chainId) === chainId)?.tokens ?? [];
    }

    estimate(chainId: bigint, kind: EstimateKind): Promise<EstimateResponse> {
        if (kind === "swap") return this.client.estimateSwap(chainId);
        if (kind === "deposit") return this.client.estimateDeposit(chainId);
        return this.client.estimateSpend(chainId, kind);
    }
}
