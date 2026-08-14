// Asset metadata resolution. The MASP addresses assets by a `uint64` id;
// everything a caller needs to turn that id into a human amount (ERC-20
// address, `scale`, symbol, decimals) is gathered here.

import type { ChainAdapter } from "../chain/port.js";
import {
    type AssetId,
    branded,
    type CircuitAmount,
    type CircuitAmountLike,
    circuitAmount,
    type EvmAddress,
} from "../core/brand.js";
import { InvalidArgumentError } from "../core/errors.js";
import { formatUnits, parseUnits, toCircuitUnits, toTokenUnits } from "../core/units.js";

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
    /** From `chain.tokenMeta`; undefined when the adapter does not implement it. */
    symbol?: string | undefined;
    /** ERC-20 decimals. Undefined when the adapter has no `tokenMeta`. */
    decimals?: number | undefined;
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
export async function fetchAssetInfo(chain: ChainAdapter, id: AssetId): Promise<AssetInfo> {
    const entry = await chain.fetchAsset(id);
    const info: AssetInfo = {
        id,
        token: entry.token,
        scale: entry.scale,
        disabled: entry.disabled,
    };
    if (chain.tokenMeta) {
        try {
            const meta = await chain.tokenMeta(entry.token);
            info.symbol = meta.symbol;
            info.decimals = meta.decimals;
        } catch {
            // Non-standard ERC-20s omit symbol()/decimals(); amounts still work.
        }
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
    return toCircuitUnits(branded(parseUnits(value, meta.decimals)), meta.scale);
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
    const text = formatUnits(toTokenUnits(circuitAmount(amount), meta.scale), meta.decimals);
    return opts.symbol && meta.symbol ? `${text} ${meta.symbol}` : text;
}

/** Smallest non-zero amount the asset can express, as a decimal string. */
export function minAmount(asset: AssetInfo): string {
    return formatAmount(branded(1n), asset);
}
