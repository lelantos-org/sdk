// The wallet's view of which assets exist and how a caller may name them.
//
// Built from the relayer's `/chains` response (`ChainInfo.tokens`), which lists
// every registered asset with its address, scale, symbol and decimals.
//
// The registry is a cache, not a source of truth. An unknown id is resolved
// from the chain registry (`chain.fetchAsset`), so a wallet configured against a
// bare RPC, with no relayer or token list, can still resolve ids.
//
// Trust split. The relayer's list is used for NAME RESOLUTION and DISPLAY only:
// turning a symbol or token address into an id, and supplying `symbol` /
// `decimals` when the token does not report them. `resolve` and `list` return
// its entries as-is, so their value-bearing fields are advisory. Anything that
// signs, approves, pulls, transfers or sizes an amount goes through
// `resolveVerified`, which re-reads the id from the pool and refuses (with
// `WireFormatError`) a list that contradicts it.

import type { ChainReader } from "../../chain/port.js";
import { isContractRevert } from "../../chain/revert.js";
import { type AssetId, assetId } from "../../core/brand.js";
import { cmpBigint } from "../../core/compare.js";
import { InvalidArgumentError } from "../../errors/config.js";
import { WireFormatError } from "../../errors/network.js";
import { type DenominationPolicy, resolveLadder } from "../../protocol/denominations.js";
import { type FeeOverride, type FeeRates, resolveFeeRates } from "../../protocol/fees.js";
import type { ChainToken } from "../../protocol/responses.js";
import { RAY } from "../../protocol/units.js";
import { type AssetRef, classifyRef, describeRef, matchRef } from "./asset-ref.js";
import { type AssetInfo, fetchAssetInfo } from "./info.js";

/**
 * Whether `err` from {@link AssetRegistry.resolve} means the asset does not exist, rather than
 * that the lookup failed.
 *
 * A symbol or address with no match is an `InvalidArgumentError` on `asset`; an id the pool does
 * not know reverts `UnknownAsset`. A transport failure is neither.
 */
export function isUnknownAsset(err: unknown): boolean {
    if (err instanceof InvalidArgumentError) return err.argument === "asset";
    return isContractRevert(err);
}

/** Where a registry's token list comes from. */
export interface AssetRegistrySource {
    chain: ChainReader;
    /**
     * Whether assets resolve with a withdrawal ladder. Defaults to `true`;
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
     * once and cached. A failure is not fatal: symbols and token addresses
     * become unresolvable, while ids still resolve.
     */
    tokens?: (() => Promise<readonly ChainToken[]>) | undefined;
}

/** Everything the wire carries about an asset except its two fee rates. */
type UnpricedAsset = Omit<AssetInfo, keyof FeeRates>;

/**
 * The rates for `t`, or `undefined` when the relayer has not indexed them.
 *
 * An absent rate is unknown, not zero: defaulting to zero while the indexer lags
 * would quote a free withdrawal and misstate what the recipient receives. An
 * override replaces the rates outright, including missing ones.
 */
function feesFromChainToken(t: ChainToken, feeBps: FeeOverride | undefined): FeeRates | undefined {
    if (feeBps !== undefined) return resolveFeeRates({ depositBps: 0n, withdrawBps: 0n }, feeBps);
    if (t.depositBps === undefined || t.withdrawBps === undefined) return undefined;
    return { depositBps: BigInt(t.depositBps), withdrawBps: BigInt(t.withdrawBps) };
}

/**
 * `ChainToken` (wire) → everything but the fee rates.
 *
 * Separated from the rates because the relayer may omit them, while the symbol
 * and decimals it carries cannot be re-derived from the pool; a missing rate is
 * filled in around this value instead of rebuilding the entry.
 */
function fromChainToken(t: ChainToken, denominations: DenominationPolicy): UnpricedAsset {
    // Parsed once so `scale` and the ladder derived from it use the same value.
    const scale = BigInt(t.scale);
    const info: UnpricedAsset = {
        id: assetId(BigInt(t.assetId)),
        token: t.token as AssetInfo["token"],
        scale,
        // `/chains` does not carry the disabled flag; a disabled asset still
        // resolves and the chain rejects it at `deposit`.
        disabled: false,
        // No `yieldState` means a plain asset, or a yielding one the relayer has
        // not priced yet. `RAY` is the identity for every conversion; for the
        // latter, human amounts read low until the relayer provides the field.
        index: t.yieldState === undefined ? RAY : BigInt(t.yieldState.index),
        yieldEnabled: t.yieldState !== undefined,
        ladder: resolveLadder({ scale, decimals: t.decimals }, denominations),
    };
    if (t.symbol !== undefined) info.symbol = t.symbol;
    if (t.decimals !== undefined) info.decimals = t.decimals;
    // Kept separate from `index`: the pool divides by this pair, and charges must
    // be sized from it.
    if (t.yieldState !== undefined) {
        info.rate = {
            gross: BigInt(t.yieldState.gross),
            supply: BigInt(t.yieldState.supply),
        };
    }
    return info;
}

/**
 * How long a chain-verified entry from {@link AssetRegistry.resolveVerified} is reused.
 *
 * Short because the yield `index` and `rate` move with every block and `disabled` can flip; long
 * enough that one operation resolving the same asset several times (a deposit and its fee asset,
 * a spend and its `feeAsset`, a UI re-rendering) reads the pool once. Concurrent resolutions of
 * one id share a single read.
 */
export const VERIFIED_ASSET_TTL_MS = 5_000;

/** An entry as the relayer listed it, kept to cross-check against the chain. */
type ListedAsset = Pick<AssetInfo, "id" | "token" | "scale" | "symbol" | "decimals">;

export class AssetRegistry {
    private readonly src: AssetRegistrySource;
    private readonly byId = new Map<bigint, AssetInfo>();
    /** The relayer's own claims per id, never overwritten by a chain read. */
    private readonly listedById = new Map<bigint, ListedAsset>();
    /** Chain-verified entries, see `VERIFIED_ASSET_TTL_MS` (5 s). */
    private readonly verified = new Map<bigint, { at: number; info: Promise<AssetInfo> }>();
    /** Resolves once; a failed load is retried on the next call. */
    private listed: Promise<void> | undefined;

    constructor(src: AssetRegistrySource) {
        this.src = src;
    }

    /**
     * Everything the registry knows, lowest id first.
     *
     * For display. Entries come from the relayer's list and are not checked
     * against the chain: `token`, `scale`, fee rates, yield state and `ladder`
     * are advisory. Pass an entry's `id` to {@link resolveVerified} before
     * using any of them to move value.
     */
    async list(): Promise<AssetInfo[]> {
        await this.load();
        return [...this.byId.values()].sort((a, b) => cmpBigint(a.id, b.id));
    }

    /**
     * The asset `ref` names, as the token list describes it.
     *
     * An id not in the token list is read from the chain, so a wallet with no
     * relayer still resolves ids. Symbols and addresses cannot be enumerated
     * from the chain, so an unmatched one fails with the known assets listed.
     *
     * Name resolution and display only: a listed entry is the relayer's claim,
     * so every field but `id`, `symbol` and `decimals` is advisory. Operations
     * that sign, pull, transfer or size amounts use {@link resolveVerified}.
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

    /**
     * The asset `ref` names, with every value-bearing field read from the pool.
     *
     * The token list only maps `ref` to an id. `token`, `scale`, `disabled`,
     * both fee rates (unless `feeBps` overrides them), `index`, `rate` and
     * `yieldEnabled` come from `chain.fetchAsset`; `symbol` and `decimals` from
     * the token itself when it reports them, else from the list; `ladder` is
     * derived from the chain `scale` and those `decimals`.
     *
     * Reused for `VERIFIED_ASSET_TTL_MS` (5 s).
     *
     * @throws {WireFormatError} when the relayer's list contradicts the chain
     * for this id (token address, `scale` or `decimals`), or names by address or
     * symbol an id whose on-chain token is a different one. Neither source is
     * preferred: a relayer that misstates the asset could have a caller sign a
     * pull of the wrong token or amount, so nothing is signed.
     */
    async resolveVerified(ref: AssetRef): Promise<AssetInfo> {
        const { id } = await this.resolve(ref);
        const now = Date.now();
        let slot = this.verified.get(id);
        if (slot === undefined || now - slot.at >= VERIFIED_ASSET_TTL_MS) {
            const fresh = { at: now, info: this.readVerified(id) };
            // A failed read is not the cached answer; the next call retries.
            fresh.info.catch(() => {
                if (this.verified.get(id) === fresh) this.verified.delete(id);
            });
            this.verified.set(id, fresh);
            slot = fresh;
        }
        const info = await slot.info;
        assertRefMatchesChain(ref, info);
        return info;
    }

    /**
     * Re-read `ref` from the chain registry, replacing the cached entry.
     *
     * Verified as {@link resolveVerified} is, bypassing its cache.
     */
    async refresh(ref: AssetRef): Promise<AssetInfo> {
        const { id } = await this.resolve(ref);
        this.verified.delete(id);
        const info = await this.resolveVerified(ref);
        this.put(info);
        return info;
    }

    /** Seed or replace what the registry knows about `id`. */
    put(info: AssetInfo): void {
        this.byId.set(info.id, info);
    }

    /** Cached entry for `id`, without touching the network. */
    peek(id: AssetId): AssetInfo | undefined {
        return this.byId.get(id);
    }

    /** The chain's entry for `id`, cross-checked against and merged with the relayer's. */
    private async readVerified(id: AssetId): Promise<AssetInfo> {
        const denominations = this.src.denominations ?? true;
        const onChain = await fetchAssetInfo(this.src.chain, id, denominations, this.src.feeBps);
        const listed = this.listedById.get(id);
        if (listed === undefined) return onChain;

        if (listed.token.toLowerCase() !== onChain.token.toLowerCase()) {
            throw listMismatch(id, "token", listed.token, onChain.token);
        }
        if (listed.scale !== onChain.scale) {
            throw listMismatch(id, "scale", listed.scale, onChain.scale);
        }
        if (
            listed.decimals !== undefined &&
            onChain.decimals !== undefined &&
            listed.decimals !== onChain.decimals
        ) {
            throw listMismatch(id, "decimals", listed.decimals, onChain.decimals);
        }

        const info: AssetInfo = { ...onChain };
        const symbol = onChain.symbol ?? listed.symbol;
        if (symbol !== undefined) info.symbol = symbol;
        if (onChain.decimals === undefined && listed.decimals !== undefined) {
            // The token does not report `decimals`, so the list's value is the only one; the
            // ladder is re-derived so it agrees with it, as a listed entry's does.
            info.decimals = listed.decimals;
            info.ladder = resolveLadder(
                { scale: onChain.scale, decimals: listed.decimals },
                denominations,
            );
        }
        return info;
    }

    private unknown(ref: AssetRef): string {
        const known = [...this.byId.values()]
            .map((a) => a.symbol ?? `id ${a.id}`)
            .sort()
            .join(", ");
        return known
            ? `no registered asset for ${describeRef(ref)}. Known: ${known}`
            : `no registered asset for ${describeRef(ref)}, and no asset list is available — ` +
                  "check that `relayerUrl` is configured and reachable so symbols and token " +
                  "addresses can be resolved, or name the asset by its numeric id";
    }

    private load(): Promise<void> {
        this.listed ??= this.fetchTokens().catch((e) => {
            // Retried on the next call so a transient relayer outage does not
            // leave the registry permanently empty.
            this.listed = undefined;
            throw e;
        });
        // A missing or failing token list is not fatal; ids still resolve.
        return this.listed.catch(() => undefined);
    }

    private async fetchTokens(): Promise<void> {
        if (!this.src.tokens) return;
        const listed = await this.src.tokens();
        const denominations = this.src.denominations ?? true;

        // Two passes: decode the wire entries, then read missing fee rates from
        // the pool concurrently, only for the assets that need them, to avoid one
        // serial RPC per asset at startup.
        //
        // Pool rates are merged into the wire entry instead of replacing it:
        // `symbol` and `decimals` come only from the relayer, and dropping them
        // would make the asset unresolvable by name.
        const pending: Array<{ base: UnpricedAsset; fees: Promise<FeeRates | undefined> }> = [];
        for (const t of listed) {
            const base = fromChainToken(t, denominations);
            this.listedById.set(base.id, {
                id: base.id,
                token: base.token,
                scale: base.scale,
                symbol: base.symbol,
                decimals: base.decimals,
            });
            // Never overwrite an entry read from the chain, which carries
            // `disabled` and is authoritative for scale.
            if (this.byId.has(base.id)) continue;
            const fees = feesFromChainToken(t, this.src.feeBps);
            pending.push({
                base,
                fees:
                    fees !== undefined
                        ? Promise.resolve(fees)
                        : this.src.chain
                              .fetchAsset(base.id)
                              // Non-fatal: the id is not listed but still
                              // resolves on demand.
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

/** The relayer's list and the pool disagree about `field` of asset `id`. */
function listMismatch(
    id: AssetId,
    field: "token" | "scale" | "decimals" | "symbol",
    listed: unknown,
    onChain: unknown,
): WireFormatError {
    return new WireFormatError(
        `/chains tokens[assetId=${id}].${field}`,
        `the relayer's asset list gives ${field} ${String(listed)} for asset ${id}, but the ` +
            `pool's registry has ${String(onChain)}; refusing to use either before anything is ` +
            "signed. Check the configured relayer",
        {
            details: {
                asset: id.toString(),
                field,
                listed: String(listed),
                onChain: String(onChain),
            },
        },
    );
}

/**
 * A ref the list resolved by address or symbol must name the token the pool registers under the
 * id it mapped to; otherwise the relayer redirected the name to another asset.
 */
function assertRefMatchesChain(ref: AssetRef, info: AssetInfo): void {
    const want = classifyRef(ref);
    if (want.kind === "token" && want.token !== info.token.toLowerCase()) {
        throw listMismatch(info.id, "token", want.token, info.token);
    }
    if (
        want.kind === "symbol" &&
        info.symbol !== undefined &&
        info.symbol.toLowerCase() !== want.symbol
    ) {
        throw listMismatch(info.id, "symbol", want.symbol, info.symbol);
    }
}
