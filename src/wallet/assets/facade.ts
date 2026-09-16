// The asset lookups an operation needs, built from wallet configuration.

import type { ChainReader } from "../../chain/port.js";
import type { DenominationPolicy } from "../../protocol/denominations.js";
import type { FeeOverride } from "../../protocol/fees.js";
import type { ChainToken } from "../../protocol/responses.js";
import type { AssetRef } from "./asset-ref.js";
import type { AssetInfo } from "./info.js";
import type { AssetRegistry } from "./registry.js";

/**
 * Resolve assets named by id, token address or symbol. `AssetRegistry` implements it.
 *
 * Two trust levels; see `AssetRegistry`. An operation that signs, approves, pulls, transfers or
 * computes an amount or fee from the entry must use {@link AssetsFacade.resolveVerified}.
 */
export interface AssetsFacade {
    /**
     * The asset `ref` names, as the relayer's list describes it; cached for the wallet's lifetime.
     * Name resolution and display only: value-bearing fields are advisory.
     */
    resolve(ref: AssetRef): Promise<AssetInfo>;
    /**
     * The asset `ref` names, with token, scale, fees, yield state and ladder read from the pool.
     * Throws `WireFormatError` when the relayer's list contradicts the chain.
     */
    resolveVerified(ref: AssetRef): Promise<AssetInfo>;
    /** Re-read and verify `ref` from the chain registry, replacing the cached entry. */
    refresh(ref: AssetRef): Promise<AssetInfo>;
    /** Every known asset, lowest id first. Display only: entries are the relayer's claims. */
    list(): Promise<AssetInfo[]>;
}

/** The configuration an asset registry is built from. */
interface AssetsConfig {
    denominations?: DenominationPolicy | undefined;
    feeBps?: FeeOverride | undefined;
}

/**
 * An {@link AssetsFacade} whose registry is built on first use.
 *
 * `chain` is a thunk so a wallet without a chain adapter (a watch wallet) can
 * report that as a config error from the lookup that needs it, rather than at
 * construction.
 */
export function lazyAssets(
    chain: () => ChainReader,
    cfg: AssetsConfig,
    tokens?: (() => Promise<readonly ChainToken[]>) | undefined,
): AssetsFacade {
    // The registry (fee, yield and ladder resolution) loads at the first lookup, so a wallet that
    // only syncs and lists notes never downloads it. A failed load is retried on the next lookup.
    let registry: Promise<AssetRegistry> | undefined;
    const get = (): Promise<AssetRegistry> => {
        registry ??= import("./registry.js").then(
            ({ AssetRegistry }) =>
                new AssetRegistry({
                    chain: chain(),
                    denominations: cfg.denominations ?? true,
                    ...(cfg.feeBps !== undefined ? { feeBps: cfg.feeBps } : {}),
                    ...(tokens ? { tokens } : {}),
                }),
            (err: unknown) => {
                registry = undefined;
                throw err;
            },
        );
        return registry;
    };
    return {
        resolve: async (ref) => (await get()).resolve(ref),
        resolveVerified: async (ref) => (await get()).resolveVerified(ref),
        refresh: async (ref) => (await get()).refresh(ref),
        list: async () => (await get()).list(),
    };
}
