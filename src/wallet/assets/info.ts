// What the MASP registry knows about an asset, resolved into one record.
//
// The pool addresses assets by a `uint64` id; this resolves it into the ERC-20
// address, `scale`, fee rates, yield state and ladder. Amount conversion is in
// `./amount.ts`.

import type { ChainReader } from "../../chain/port.js";
import { isContractRevert } from "../../chain/revert.js";
import type { TokenMeta } from "../../chain/types.js";
import type { AssetId, EvmAddress } from "../../core/brand.js";
import { InvalidArgumentError } from "../../errors/config.js";
import {
    type DenominationPolicy,
    type Ladder,
    resolveLadder,
} from "../../protocol/denominations.js";
import { type FeeOverride, resolveFeeRates } from "../../protocol/fees.js";
import { RAY, type YieldRate } from "../../protocol/units.js";

/**
 * Everything known about a registered MASP asset.
 *
 * `scale` converts between the two integer spaces:
 * `tokenUnits = circuitUnits * scale` (times `index / RAY` for a yield asset).
 */
export interface AssetInfo {
    /** MASP registry id — the `asset` argument on every wallet method. */
    id: AssetId;
    /** ERC-20 contract address backing the id. */
    token: EvmAddress;
    /** circuit-units → ERC-20-base-units multiplier. */
    scale: bigint;
    /** Owner-flipped. Disabled assets block new deposits; existing notes stay spendable. */
    disabled: boolean;
    /**
     * Protocol fee on the shield leg, in basis points, charged **on top of**
     * the principal.
     *
     * Per-asset and per-leg; there is no pool-wide rate. See
     * {@link AssetInfo.withdrawBps}, which is deducted rather than added and may
     * differ.
     */
    depositBps: bigint;
    /**
     * Protocol fee on the unshield leg, in basis points, **skimmed from** the
     * gross leaving the pool, so a withdrawal of `publicOut` delivers less than
     * `publicOut`. See `withdrawNetFor` (`@lelantos-org/sdk/protocol`).
     */
    withdrawBps: bigint;
    /** From `chain.tokenMeta`; undefined when the adapter does not implement it. */
    symbol?: string | undefined;
    /** ERC-20 decimals. Undefined when the adapter has no `tokenMeta`. */
    decimals?: number | undefined;
    /**
     * Pool-managed yield index, RAY-scaled, `RAY` when the pool reports none.
     *
     * `tokenUnits = circuitUnits * scale * index / RAY`. The underlying value of
     * a fixed circuit amount grows over time while the circuit amount stays
     * constant, which is why a withdrawal denomination is a circuit-unit integer
     * rather than a human amount.
     */
    index: bigint;
    /** Whether the pool routes this asset to a yield venue. */
    yieldEnabled: boolean;
    /**
     * The pool's own measure of what a unit is worth, for sizing a payment.
     *
     * Present only for a yield asset the source has priced. `index` is floored
     * on chain, so converting a charge through it can fall below what the
     * contract takes; this pair is what the pool divides by. A yielding asset
     * without `rate` cannot be quoted: `scale` is off by whatever the venue has
     * earned.
     */
    rate?: YieldRate;
    /**
     * Withdrawal denominations for this asset, ascending, derived from its
     * `scale` and `decimals`; `[]` only when the wallet opted out via
     * `WalletConfig.denominations`. Resolved here so downstream code does not
     * need the policy.
     */
    ladder: Ladder;
}

/**
 * An asset whose ERC-20 `decimals` is known. Human-unit conversion is only
 * defined against this variant, so `parseAmount` / `formatAmount` reject an
 * unresolved `AssetInfo` at compile time instead of throwing.
 *
 * Narrow with {@link hasTokenMeta}, or assert with {@link requireTokenMeta}.
 */
export interface AssetInfoWithMeta extends AssetInfo {
    decimals: number;
}

/** Narrow an `AssetInfo` to the variant that carries ERC-20 `decimals`. */
export function hasTokenMeta(asset: AssetInfo): asset is AssetInfoWithMeta {
    return asset.decimals !== undefined;
}

/**
 * Assert that `decimals` resolved.
 *
 * @throws {InvalidArgumentError} when the chain adapter exposed no
 * `tokenMeta`, so no human-unit conversion is defined for this asset.
 */
export function requireTokenMeta(asset: AssetInfo): AssetInfoWithMeta {
    if (!hasTokenMeta(asset)) {
        throw new InvalidArgumentError(
            `asset ${asset.id} (${asset.token}) has no known decimals — the chain ` +
                `adapter does not implement \`tokenMeta\`. Set \`decimals\` on the ` +
                `AssetInfo yourself, or work in circuit units.`,
            { argument: "asset" },
        );
    }
    return asset;
}

/**
 * Read the registry entry for `id`, enriched with ERC-20 metadata when the
 * adapter exposes `tokenMeta`. Metadata failures are non-fatal: `symbol` and
 * `decimals` are left undefined.
 */
export async function fetchAssetInfo(
    chain: ChainReader,
    id: AssetId,
    denominations: DenominationPolicy = true,
    feeBps?: FeeOverride | undefined,
): Promise<AssetInfo> {
    const entry = await chain.fetchAsset(id);
    const fees = resolveFeeRates(entry, feeBps);
    // Read before the ladder is resolved: `decimals` clamps the ladder window to
    // the asset's granularity.
    let meta: TokenMeta | undefined;
    if (chain.tokenMeta) {
        try {
            meta = await chain.tokenMeta(entry.token);
        } catch (err) {
            // Non-standard ERC-20s omit symbol()/decimals(); amounts still work. Only the token's
            // own refusal means that: a failed read propagates, since an entry built without
            // `decimals` resolves a different ladder and callers cache what this returns.
            if (!isContractRevert(err)) throw err;
        }
    }
    const info: AssetInfo = {
        id,
        token: entry.token,
        scale: entry.scale,
        disabled: entry.disabled,
        depositBps: fees.depositBps,
        withdrawBps: fees.withdrawBps,
        index: entry.index,
        yieldEnabled: entry.yieldEnabled,
        ladder: resolveLadder({ scale: entry.scale, decimals: meta?.decimals }, denominations),
    };
    // Set only when the adapter priced it: `rate` has no identity value to
    // default to.
    if (entry.rate) info.rate = entry.rate;
    if (meta) {
        info.symbol = meta.symbol;
        info.decimals = meta.decimals;
    }
    return info;
}

/** Input to {@link makeAssetInfo}. Everything but the first three has a default. */
export interface MakeAssetInfoArgs {
    id: AssetId;
    token: EvmAddress;
    /** circuit-units → ERC-20-base-units multiplier. */
    scale: bigint;
    /** ERC-20 decimals. Omit only if no human-unit conversion will be needed. */
    decimals?: number | undefined;
    symbol?: string | undefined;
    /** Default `false`. */
    disabled?: boolean | undefined;
    /**
     * Protocol fee rates in bps. A bare bigint sets both legs; the pair prices
     * them separately. Default `0n`.
     */
    feeBps?: FeeOverride | undefined;
    /** Pool-managed yield index, RAY-scaled. Default `RAY` (no yield accrued). */
    index?: bigint | undefined;
    /** Default `false`. */
    yieldEnabled?: boolean | undefined;
    /**
     * Whether to derive a ladder for this asset. Default `true`; `false` opts
     * out. See `protocol/denominations`.
     */
    denominations?: DenominationPolicy | undefined;
}

/**
 * Build an {@link AssetInfo} with every optional field defaulted.
 *
 * For tests, mocks, and custom registries that construct assets by hand rather
 * than through `fetchAssetInfo`. Prefer it to an object literal: it derives
 * `ladder` from `scale` and `decimals`, so the three cannot disagree, whereas a
 * mismatched literal type-checks and splits change onto the wrong denominations.
 *
 * ```ts
 * const usdc = makeAssetInfo({
 *     id: assetId(2n),
 *     token: evmAddress("0xA0b8…eB48"),
 *     scale: 1n,
 *     decimals: 6,
 * });
 * ```
 */
export function makeAssetInfo(args: MakeAssetInfoArgs): AssetInfo {
    const fees = resolveFeeRates({ depositBps: 0n, withdrawBps: 0n }, args.feeBps);
    const info: AssetInfo = {
        id: args.id,
        token: args.token,
        scale: args.scale,
        disabled: args.disabled ?? false,
        depositBps: fees.depositBps,
        withdrawBps: fees.withdrawBps,
        index: args.index ?? RAY,
        yieldEnabled: args.yieldEnabled ?? false,
        // `args` is structurally a `LadderInputs`.
        ladder: resolveLadder(args, args.denominations ?? true),
    };
    if (args.symbol !== undefined) info.symbol = args.symbol;
    if (args.decimals !== undefined) info.decimals = args.decimals;
    return info;
}
