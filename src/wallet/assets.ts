// Asset metadata resolution. The MASP addresses assets by a `uint64` id;
// everything a caller needs to turn that id into a human amount (ERC-20
// address, `scale`, symbol, decimals) is gathered here.

import type { ChainAdapter } from "../chain/port.js";
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
    id: bigint;
    /** ERC-20 contract address backing the id. */
    token: string;
    /** circuit-units → ERC-20-base-units multiplier. */
    scale: bigint;
    /** Owner-flipped. Disabled assets block new deposits; existing notes stay spendable. */
    disabled: boolean;
    /** From `chain.tokenMeta`; undefined when the adapter does not implement it. */
    symbol?: string;
    /** ERC-20 decimals. Undefined when the adapter has no `tokenMeta`. */
    decimals?: number;
}

/**
 * Read the registry entry for `id`, enriched with ERC-20 metadata when the
 * adapter exposes `tokenMeta`. Metadata failures are non-fatal: `symbol` and
 * `decimals` are left undefined.
 */
export async function fetchAssetInfo(chain: ChainAdapter, id: bigint): Promise<AssetInfo> {
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
 * @throws {RangeError} when the asset has no known `decimals`, or the value
 * is finer-grained than one circuit unit.
 */
export function parseAmount(value: string | number | bigint, asset: AssetInfo): bigint {
    return toCircuitUnits(parseUnits(value, requireDecimals(asset)), asset.scale);
}

/**
 * Circuit units → human decimal string. Pass `{ symbol: true }` to append
 * the token symbol when one is known.
 *
 * ```ts
 * formatAmount(wallet.balance(1n), weth, { symbol: true }); // "0.25 WETH"
 * ```
 */
export function formatAmount(
    circuitAmount: bigint,
    asset: AssetInfo,
    opts: { symbol?: boolean } = {},
): string {
    const text = formatUnits(toTokenUnits(circuitAmount, asset.scale), requireDecimals(asset));
    return opts.symbol && asset.symbol ? `${text} ${asset.symbol}` : text;
}

/** Smallest non-zero amount the asset can express, as a decimal string. */
export function minAmount(asset: AssetInfo): string {
    return formatAmount(1n, asset);
}

function requireDecimals(asset: AssetInfo): number {
    if (asset.decimals === undefined) {
        throw new RangeError(
            `asset ${asset.id} (${asset.token}) has no known decimals — the chain ` +
                `adapter does not implement \`tokenMeta\`. Set \`decimals\` on the ` +
                `AssetInfo yourself, or work in circuit units.`,
        );
    }
    return asset.decimals;
}
