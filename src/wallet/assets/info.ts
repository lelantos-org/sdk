// What the MASP registry knows about an asset, resolved into one record.
//
// The pool addresses assets by a `uint64` id; this turns that id into the
// ERC-20 address, `scale`, fee rates, yield state and ladder that every other
// wallet module reads. Amount conversion lives next door in `./amounts.ts`.

import type { ChainReader } from "../../chain/port.js";
import type { TokenMeta } from "../../chain/types.js";
import type { AssetId, EvmAddress } from "../../core/brand.js";
import { type DenominationPolicy, type Ladder, resolveLadder } from "../../core/denominations.js";
import { InvalidArgumentError } from "../../core/errors.js";
import { type FeeOverride, resolveFeeRates } from "../../core/fees.js";
import { RAY, type YieldRate } from "../../core/units.js";

/**
 * Everything known about a registered MASP asset.
 *
 * `scale` converts between the two integer spaces:
 * `tokenUnits = circuitUnits * scale`. Every `Wallet` amount argument is in
 * circuit units.
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
     * Per-asset and per-leg — there is no pool-wide rate — so this is resolved
     * with the asset and never looked up separately. See
     * {@link AssetInfo.withdrawBps}, which is deducted rather than added and is
     * routinely a different number.
     */
    depositBps: bigint;
    /**
     * Protocol fee on the unshield leg, in basis points, **skimmed from** the
     * gross leaving the pool — so a withdrawal of `publicOut` delivers less
     * than `publicOut`. {@link withdrawNetFor} is the split.
     */
    withdrawBps: bigint;
    /** From `chain.tokenMeta`; undefined when the adapter does not implement it. */
    symbol?: string | undefined;
    /** ERC-20 decimals. Undefined when the adapter has no `tokenMeta`. */
    decimals?: number | undefined;
    /**
     * Pool-managed yield index, RAY-scaled, `RAY` when the pool reports none.
     *
     * `tokenUnits = circuitUnits * scale * index / RAY`. Note this makes the
     * human value of a fixed circuit amount *move over time* — a note is worth
     * more underlying than it was — while the circuit amount itself never
     * changes. That is the whole point of the normalized-unit design, and it
     * is why a withdrawal denomination is a circuit-unit integer rather than a
     * human amount.
     */
    index: bigint;
    /** Whether the pool routes this asset to a yield venue. */
    yieldEnabled: boolean;
    /**
     * The pool's own measure of what a unit is worth, for sizing a payment.
     *
     * Present only for a yield asset the source has priced. `index` above is
     * floored on chain, so converting a *charge* through it can land below what
     * the contract takes; this pair is what the pool itself divides by. A
     * yielding asset with no `rate` cannot be quoted — `scale` is not a safe
     * fallback, it is wrong by whatever the venue has earned.
     */
    rate?: YieldRate;
    /**
     * Withdrawal denominations for this asset, ascending; `[]` only when the
     * wallet opted out via `WalletConfig.denominations`. Every asset otherwise
     * has one, derived from its own `scale` and `decimals`.
     *
     * Resolved once here so no code downstream needs to know the policy.
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
    // Read before the ladder is placed, not after: `decimals` is what clamps
    // the window to what this asset's granularity can express, so resolving it
    // second would place every ladder as if decimals were unknown.
    let meta: TokenMeta | undefined;
    if (chain.tokenMeta) {
        try {
            meta = await chain.tokenMeta(entry.token);
        } catch {
            // Non-standard ERC-20s omit symbol()/decimals(); amounts still work.
        }
    }
    const info: AssetInfo = {
        id,
        token: entry.token,
        scale: entry.scale,
        disabled: entry.disabled,
        depositBps: fees.depositBps,
        withdrawBps: fees.withdrawBps,
        // A pool with no yield mixin reports neither, and `RAY` is the identity
        // for every conversion — so an adapter that has never heard of an index
        // keeps exactly its previous behaviour.
        index: entry.index ?? RAY,
        yieldEnabled: entry.yieldEnabled ?? false,
        ladder: resolveLadder({ scale: entry.scale, decimals: meta?.decimals }, denominations),
    };
    // Only when the adapter priced it. Assigned rather than spread with a
    // default: `rate` has no identity value — a yielding asset without one
    // cannot be quoted at all, and `scale` is not a safe stand-in, it is wrong
    // by whatever the venue has earned.
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
     * them apart. Default `0n` — free, which is what a fixture wants unless it
     * is testing fee arithmetic.
     */
    feeBps?: FeeOverride | undefined;
    /** Pool-managed yield index, RAY-scaled. Default `RAY` (no yield accrued). */
    index?: bigint | undefined;
    /** Default `false`. */
    yieldEnabled?: boolean | undefined;
    /**
     * Whether to derive a ladder for this asset. Default `true`; `false` opts
     * out. See `core/denominations`.
     */
    denominations?: DenominationPolicy | undefined;
}

/**
 * Build an {@link AssetInfo} with every optional field defaulted.
 *
 * For tests, mocks, and custom registries that construct assets by hand rather
 * than through `fetchAssetInfo`. Worth using rather than an object literal for
 * one specific reason: it derives `ladder` from the `scale` and `decimals` it
 * is given, so the three cannot disagree. A hand-written literal that pairs one
 * asset's scale with another's ladder type-checks, runs, and silently splits
 * change onto the wrong denominations.
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
        // `args` is structurally a `LadderInputs`; repacking it would be two
        // more field names to keep in step.
        ladder: resolveLadder(args, args.denominations ?? true),
    };
    if (args.symbol !== undefined) info.symbol = args.symbol;
    if (args.decimals !== undefined) info.decimals = args.decimals;
    return info;
}
