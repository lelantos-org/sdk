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
     * The relayer's registered-asset list, if one is reachable. Called at most
     * once and cached; a failure is not fatal, it only means symbols and token
     * addresses cannot be resolved and ids still can.
     */
    tokens?: (() => Promise<readonly ChainToken[]>) | undefined;
}

/** `ChainToken` (wire) → `AssetInfo` (what the wallet hands out). */
function fromChainToken(t: ChainToken, denominations: DenominationPolicy): AssetInfo {
    const info: AssetInfo = {
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
        for (const t of await this.src.tokens()) {
            const info = fromChainToken(t, this.src.denominations ?? true);
            // Never clobber an entry read from the chain itself, which carries
            // `disabled` and is the authority on scale.
            if (!this.byId.has(info.id)) this.byId.set(info.id, info);
        }
    }
}
