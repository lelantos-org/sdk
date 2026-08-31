// Asset metadata resolution. The MASP addresses assets by a `uint64` id;
// everything a caller needs to turn that id into a human amount (ERC-20
// address, `scale`, symbol, decimals) is gathered here.

import type { ChainAdapter } from "../chain/port.js";
import type { TokenMeta } from "../chain/types.js";
import {
    type AssetId,
    branded,
    type CircuitAmount,
    type CircuitAmountLike,
    circuitAmount,
    type EvmAddress,
} from "../core/brand.js";
import {
    type DenominationPolicy,
    isDenomination,
    type Ladder,
    nearest,
    resolveLadder,
} from "../core/denominations.js";
import { InvalidArgumentError } from "../core/errors.js";
import { type FeeOverride, resolveFeeRates, type WithdrawNet, withdrawNet } from "../core/fees.js";
import {
    formatUnits,
    parseUnits,
    RAY,
    toCircuitUnits,
    toTokenUnits,
    type YieldRate,
} from "../core/units.js";

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
    chain: ChainAdapter,
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
    if (meta) {
        info.symbol = meta.symbol;
        info.decimals = meta.decimals;
    }
    return info;
}

/**
 * Human decimal string → circuit units, ready to pass as `amount`.
 *
 * ```ts
 * const weth = await wallet.asset(1n);
 * await wallet.deposit({ asset: weth.id, amount: parseAmount("0.25", weth) });
 * ```
 *
 * @throws {RangeError} when the value is finer-grained than one circuit unit.
 * @throws {InvalidArgumentError} when the chain adapter resolved no `decimals`.
 */
export function parseAmount(value: string | number | bigint, asset: AssetInfo): CircuitAmount {
    const meta = requireTokenMeta(asset);
    return toCircuitUnits(branded(parseUnits(value, meta.decimals)), meta.scale, {
        index: meta.index,
        // Two genuinely different situations, which is why the policy lives here
        // rather than in `toCircuitUnits` — that primitive keeps honouring
        // whatever a caller asks for explicitly.
        //
        // A plain asset's granularity is fixed at `scale`, so an amount finer
        // than that was never representable and silently truncating it would
        // short the user without saying so. It throws, as it always has.
        //
        // Under a moving index a unit is worth a non-round number of base
        // units, so most human amounts have no exact equivalent — including the
        // ones `formatAmount` itself produces. Refusing them would make a yield
        // asset unusable through this API, and rounding down is the safe reading
        // of an ambiguous amount: the caller gets slightly less than they asked
        // for, never more than they hold.
        // `?? RAY` is load-bearing: an asset whose index is unknown must keep
        // the strict behaviour rather than fall through to the lossy branch.
        // Treating "no index" as "yielding" would silently truncate on exactly
        // the assets we know least about.
        round: (meta.index ?? RAY) === RAY ? "exact" : "down",
    });
}

/**
 * Circuit units → human decimal string. Pass `{ symbol: true }` to append
 * the token symbol when one is known.
 *
 * ```ts
 * formatAmount(wallet.balance(weth.id), weth, { symbol: true }); // "0.25 WETH"
 * ```
 */
export function formatAmount(
    amount: CircuitAmountLike,
    asset: AssetInfo,
    opts: { symbol?: boolean } = {},
): string {
    const meta = requireTokenMeta(asset);
    const text = formatUnits(
        toTokenUnits(circuitAmount(amount), meta.scale, { index: meta.index }),
        meta.decimals,
    );
    return opts.symbol && meta.symbol ? `${text} ${meta.symbol}` : text;
}

/** Smallest non-zero amount the asset can express, as a decimal string. */
export function minAmount(asset: AssetInfo): string {
    return formatAmount(branded(1n), asset);
}

/**
 * The asset's withdrawal denominations, ascending, or `[]` when it has none.
 *
 * A withdrawal's `publicOut` is public, and normalized units do not move, so
 * the naive round trip publishes the same integer at both ends. Choosing from
 * this list is what makes that integer one many other users also publish —
 * see `core/denominations.ts` for why it is a table of fixed integers rather
 * than something derived from human amounts.
 *
 * ```ts
 * const usdc = await wallet.asset("USDC");
 * for (const d of denominations(usdc)) {
 *     console.log(formatAmount(d, usdc, { symbol: true })); // "10 USDC", "20 USDC", …
 * }
 * ```
 *
 * The human labels move as the yield index does; the denominations themselves
 * never do.
 */
export function denominations(asset: AssetInfo): Ladder {
    return asset.ladder;
}

/** Whether the asset has a withdrawal ladder at all. */
export function isDenominated(asset: AssetInfo): boolean {
    return asset.ladder.length > 0;
}

/**
 * Whether `amount` is one of the asset's denominations.
 *
 * `false` for every amount of an asset with no ladder — there is nothing to be
 * on. Callers wanting to distinguish "off the ladder" from "no ladder exists"
 * should check {@link isDenominated} first.
 */
export function isOnLadder(amount: CircuitAmountLike, asset: AssetInfo): boolean {
    return isDenomination(circuitAmount(amount), asset.ladder);
}

/**
 * The denomination closest to `amount`, or `undefined` when the asset has no
 * ladder. Ties go to the smaller, so a suggestion never silently costs more
 * than was asked for.
 */
export function nearestDenomination(
    amount: CircuitAmountLike,
    asset: AssetInfo,
): CircuitAmount | undefined {
    const found = nearest(circuitAmount(amount), asset.ladder);
    return found === undefined ? undefined : branded<CircuitAmount>(found);
}

/**
 * Split a withdrawal's gross into what the recipient receives and what the
 * protocol keeps, reading `withdrawBps`, `scale`, `index` and `yieldEnabled`
 * off the asset.
 *
 * The asset-aware wrapper over {@link withdrawNet}, and the only place those
 * four fields are mapped onto it — assembling them at each call site is how one
 * of them ends up stale or omitted, and the yield branch silently misreports the
 * net when `yieldEnabled` is the one that goes missing. Taking the rate from the
 * asset rather than as an argument also removes the way this used to go wrong
 * most easily: passing the deposit rate to a withdrawal.
 */
export function withdrawNetFor(publicOut: CircuitAmountLike, asset: AssetInfo): WithdrawNet {
    return withdrawNet({
        publicOut: circuitAmount(publicOut),
        feeBps: asset.withdrawBps,
        scale: asset.scale,
        index: asset.index,
        yieldEnabled: asset.yieldEnabled,
    });
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
