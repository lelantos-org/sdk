// The wallet's view of which assets exist, and what a caller may call them.
//
// The relayer's `/chains` already carries every registered asset with its
// address, scale, symbol and decimals — `ChainInfo.tokens`. Until now the SDK
// fetched that endpoint for nothing else and never turned it into a lookup, so
// every consumer wrote its own; this is that lookup, once.
//
// The registry is a cache, not a source of truth. An id it has never heard of
// is still resolvable straight from the chain registry (`chain.fetchAsset`),
// which is what keeps a wallet configured against a bare RPC — no relayer, no
// token list — working exactly as it did before.

import type { ChainAdapter } from "../chain/port.js";
import { type AssetId, assetId } from "../core/brand.js";
import { type DenominationPolicy, resolveLadder } from "../core/denominations.js";
import { InvalidArgumentError } from "../core/errors.js";
import { type FeeOverride, type FeeRates, resolveFeeRates } from "../core/fees.js";
import { RAY } from "../core/units.js";
import type { ChainToken } from "../protocol/responses.js";
import { type AssetRef, classifyRef, describeRef, matchRef } from "./asset-ref.js";
import { type AssetInfo, fetchAssetInfo } from "./assets.js";

/** Where a registry's token list comes from. */
export interface AssetRegistrySource {
    chain: ChainAdapter;
    /**
     * Which withdrawal ladders assets resolve with. Defaults to the built-ins;
     * `false` opts out entirely. Applied here so nothing downstream of
     * `AssetInfo` has to know the policy.
     */
    denominations?: DenominationPolicy | undefined;
    /**
     * Replaces the protocol fee rates the pool reports, for every asset. See
     * `WalletConfig.feeBps`.
     */
    feeBps?: FeeOverride | undefined;
    /**
     * The relayer's registered-asset list, if one is reachable. Called at most
     * once and cached; a failure is not fatal, it only means symbols and token
     * addresses cannot be resolved and ids still can.
     */
    tokens?: (() => Promise<readonly ChainToken[]>) | undefined;
}

/** Everything the wire carries about an asset except its two fee rates. */
type UnpricedAsset = Omit<AssetInfo, keyof FeeRates>;

/**
 * The rates for `t`, or `undefined` when the relayer has not indexed them.
 *
 * `undefined` rather than a zero default: an absent rate is unknown, and
 * quoting a free withdrawal because the indexer is behind would under-report
 * what the recipient actually gets. An override replaces the rates outright,
 * so it also stands in for ones that never arrived.
 */
function feesFromChainToken(t: ChainToken, feeBps: FeeOverride | undefined): FeeRates | undefined {
    if (feeBps !== undefined) return resolveFeeRates({ depositBps: 0n, withdrawBps: 0n }, feeBps);
    if (t.depositBps === undefined || t.withdrawBps === undefined) return undefined;
    return { depositBps: BigInt(t.depositBps), withdrawBps: BigInt(t.withdrawBps) };
}

/**
 * `ChainToken` (wire) → everything but the fee rates.
 *
 * Split from the rates because they are the one field the relayer can be
 * missing: the symbol and decimals it does carry are not re-derivable from the
 * pool, so completing an entry must fill the rates in around this rather than
 * rebuild it.
 */
function fromChainToken(t: ChainToken, denominations: DenominationPolicy): UnpricedAsset {
    const info: UnpricedAsset = {
        id: assetId(BigInt(t.assetId)),
        token: t.token as AssetInfo["token"],
        scale: BigInt(t.scale),
        // `/chains` lists registered assets and does not carry the disabled
        // flag; a disabled asset still resolves, and `deposit` is where the
        // chain rejects it.
        disabled: false,
        // A relayer predating the yield mixin sends neither field. `RAY` is the
        // identity for every conversion, so an old relayer keeps working — but
        // it also means a wallet resolving through `/chains` against a *yielding*
        // pool would read human amounts low until the relayer ships the field.
        index: t.index === undefined ? RAY : BigInt(t.index),
        yieldEnabled: t.yieldEnabled ?? false,
        ladder: resolveLadder(t.token, denominations),
    };
    if (t.symbol !== undefined) info.symbol = t.symbol;
    if (t.decimals !== undefined) info.decimals = t.decimals;
    return info;
}

export class AssetRegistry {
    private readonly src: AssetRegistrySource;
    private readonly byId = new Map<bigint, AssetInfo>();
    /** Resolves once; a failed load is retried on the next call. */
    private listed: Promise<void> | undefined;

    constructor(src: AssetRegistrySource) {
        this.src = src;
    }

    /** Everything the registry knows, lowest id first. */
    async list(): Promise<AssetInfo[]> {
        await this.load();
        return [...this.byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }

    /**
     * The asset `ref` names.
     *
     * An id not in the token list is read straight from the chain, so a wallet
     * with no relayer still resolves every id it could before. A symbol or
     * address cannot be derived that way — there is nothing to enumerate — so
     * those fail with what the registry does know.
     */
    async resolve(ref: AssetRef): Promise<AssetInfo> {
        const kind = classifyRef(ref);
        await this.load();

        const hit = matchRef([...this.byId.values()], ref);
        if (hit) return hit;

        if (kind.kind === "id") {
            const info = await fetchAssetInfo(
                this.src.chain,
                kind.id,
                this.src.denominations ?? true,
                this.src.feeBps,
            );
            this.byId.set(info.id, info);
            return info;
        }
        throw new InvalidArgumentError(this.unknown(ref), { argument: "asset" });
    }

    /** Seed or replace what the registry knows about `id`. */
    put(info: AssetInfo): void {
        this.byId.set(info.id, info);
    }

    /** Cached entry for `id`, without touching the network. */
    peek(id: AssetId): AssetInfo | undefined {
        return this.byId.get(id);
    }

    private unknown(ref: AssetRef): string {
        const known = [...this.byId.values()]
            .map((a) => a.symbol ?? `id ${a.id}`)
            .sort()
            .join(", ");
        return known
            ? `no registered asset for ${describeRef(ref)}. Known: ${known}`
            : `no registered asset for ${describeRef(ref)}, and no asset list is available — ` +
                  "configure `relayerUrl` (or pass `assets`) so symbols and token addresses " +
                  "can be resolved, or name the asset by its numeric id";
    }

    private load(): Promise<void> {
        this.listed ??= this.fetchTokens().catch((e) => {
            // Retried next call: a relayer that was briefly down should not
            // leave the registry permanently empty.
            this.listed = undefined;
            throw e;
        });
        // A missing or failing token list is not fatal — ids still resolve.
        return this.listed.catch(() => undefined);
    }

    private async fetchTokens(): Promise<void> {
        if (!this.src.tokens) return;
        const listed = await this.src.tokens();
        const denominations = this.src.denominations ?? true;

        // Two passes. Everything the wire carries is decoded first, then the
        // fee rates it was missing are read from the pool — concurrently, and
        // only for the assets that need it. Serialising one RPC per asset at
        // boot is the kind of regression nobody notices until the list is long.
        //
        // The pool read fills the rates *into* the wire entry rather than
        // replacing it: `symbol` and `decimals` come from the relayer and are
        // not re-derivable from the registry, so rebuilding would silently stop
        // resolving this asset by name.
        const pending: Array<{ base: UnpricedAsset; fees: Promise<FeeRates | undefined> }> = [];
        for (const t of listed) {
            const base = fromChainToken(t, denominations);
            // Never clobber an entry read from the chain itself, which carries
            // `disabled` and is the authority on scale.
            if (this.byId.has(base.id)) continue;
            const fees = feesFromChainToken(t, this.src.feeBps);
            pending.push({
                base,
                fees:
                    fees !== undefined
                        ? Promise.resolve(fees)
                        : this.src.chain
                              .fetchAsset(base.id)
                              // Non-fatal, like a missing token list: the id
                              // still resolves on demand, it is just not listed.
                              .catch(() => undefined),
            });
        }

        const resolved = await Promise.all(pending.map((p) => p.fees));
        pending.forEach(({ base }, i) => {
            const fees = resolved[i];
            if (!fees || this.byId.has(base.id)) return;
            this.byId.set(base.id, {
                ...base,
                depositBps: fees.depositBps,
                withdrawBps: fees.withdrawBps,
            });
        });
    }
}
