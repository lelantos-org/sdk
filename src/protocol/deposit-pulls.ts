// What a deposit takes from the public wallet, per asset and per token, and
// which assets may pay its relayer.
//
// Pure, over plain registry fields, so a UI sizing balances and allowances
// applies the same rules `deposit` signs over instead of re-deriving
// them. Two questions, answered by two different keys:
//
//   * Whether the relayer note rides in the principal's pull is decided by
//     **asset id** (`isSameFeeAsset`): a plain id and a yield id over one ERC-20
//     price and book differently, and are still two pulls.
//   * What a balance or an allowance must cover is decided by **token**: Permit2
//     keys an allowance by `(owner, token, spender)`, and two pulls of one ERC-20
//     draw on one balance, so they are summed.

import { branded, type TokenAmount } from "../core/brand.js";
import { depositCeiling, isSameFeeAsset } from "./fees.js";

/**
 * Why an asset may not pay a deposit's relayer fee:
 *
 * - `"native-deposit"`: the deposit sends the native coin (`native`), and
 *   `NativeAdapter` pulls the wrapped coin alone;
 * - `"yield-fee-asset"`: the fee asset earns yield and is not the deposited
 *   asset, which the pool refuses (`FeeAssetUnsupported`).
 */
export type DepositFeeAssetRefusal = "native-deposit" | "yield-fee-asset";

/**
 * Why `feeAsset` may not pay the relayer for a deposit of `deposited`, or
 * `undefined` when it may.
 *
 * The deposited asset always may, a yield one included and on the native-ETH
 * path too. `wallet.deposit` throws `InvalidArgumentError` on `feeAsset` for
 * exactly the refusals this returns, before anything is quoted or signed.
 */
export function depositFeeAssetRefusal(
    deposited: { id: bigint },
    feeAsset: { id: bigint; yieldEnabled: boolean },
    native: boolean,
): DepositFeeAssetRefusal | undefined {
    if (feeAsset.id === deposited.id) return undefined;
    if (native) return "native-deposit";
    if (feeAsset.yieldEnabled) return "yield-fee-asset";
    return undefined;
}

/** The registry fields {@link depositPulls} reads. */
export interface DepositPullAsset {
    /** Registry id. */
    id: bigint;
    /** The ERC-20 the asset is pulled in. Compared case-insensitively. */
    token: string;
    /** Whether the pool routes the asset to a yield venue. */
    yieldEnabled: boolean;
}

/** One pull, named by an asset over its token. */
export interface DepositPullEntry<
    A extends DepositPullAsset = DepositPullAsset,
    T extends TokenAmount | undefined = TokenAmount,
> {
    /**
     * The asset the pull is for. In a per-token entry, the first asset naming
     * the token: the deposited one where the fee shares its token.
     */
    asset: A;
    /**
     * Base units of `asset.token`, or `undefined` while a figure summed into it
     * is unknown. Never a partial sum: an allowance sized on one would be short.
     */
    amount: T;
}

/** What {@link depositPulls} reads. */
export interface DepositPullsArgs<
    A extends DepositPullAsset = DepositPullAsset,
    T extends TokenAmount | undefined = TokenAmount,
> {
    /** The asset being shielded. */
    deposited: A;
    /** The asset paying the relayer; `deposited` where none was chosen. */
    feeAsset: A;
    /**
     * The principal plus its protocol fee, in base units of `deposited`: the
     * `principal` of `depositTotals`.
     */
    principal: T;
    /**
     * The relayer's charge, in base units of `feeAsset`: the `relayer` of
     * `depositTotals`. `undefined` while unknown; the ids alone then decide
     * whether the fee is pulled separately.
     */
    relayer: T;
    /**
     * Size the deposited asset's pull as the ceiling to authorise
     * (`depositCeiling`: yield headroom) rather than the quote, as
     * `deposit` signs and checks allowances. Applied before pulls of
     * one token are summed. Defaults to `false`.
     */
    ceiling?: boolean | undefined;
}

/** A deposit's pulls, per asset as the pool requests them and per token. */
export interface DepositPulls<
    A extends DepositPullAsset = DepositPullAsset,
    T extends TokenAmount | undefined = TokenAmount,
> {
    /**
     * The asset paying the relayer when the pool pulls its fee on its own, or
     * `undefined` when the fee rides in the principal's pull: paid in the
     * deposited asset, or zero ({@link isSameFeeAsset}).
     */
    separateFee: A | undefined;
    /**
     * The fee is drawn from the deposited token's balance and allowance: it
     * rides in the principal's pull, or is another id over the same ERC-20.
     */
    feeSharesToken: boolean;
    /**
     * The pulls as the pool requests them, the Permit2 batch permit's entries:
     * the deposited asset's first (the relayer note included when it rides
     * along), then the fee asset's exactly when `separateFee` is set.
     */
    byAsset: DepositPullEntry<A, T>[];
    /**
     * `byAsset` summed per distinct token, the deposited token first: what each
     * public balance and Permit2 allowance must cover.
     */
    byToken: DepositPullEntry<A, T>[];
}

/**
 * What a deposit pulls from the payer, per asset and per token.
 *
 * A zero relayer charge is a self-pad note in the deposited asset, whatever
 * `feeAsset` names, so it rides the principal's pull. While `relayer` is
 * unknown the fee is taken as separate exactly when `feeAsset` is another id.
 */
export function depositPulls<A extends DepositPullAsset, T extends TokenAmount | undefined>(
    args: DepositPullsArgs<A, T>,
): DepositPulls<A, T> {
    const { deposited, feeAsset, principal, relayer, ceiling = false } = args;
    const separate =
        relayer === undefined
            ? feeAsset.id !== deposited.id
            : !isSameFeeAsset(relayer, feeAsset.id, deposited.id);
    const size = (amount: T): T =>
        (ceiling && amount !== undefined
            ? depositCeiling(amount, deposited.yieldEnabled)
            : amount) as T;
    const byAsset: DepositPullEntry<A, T>[] = separate
        ? [
              { asset: deposited, amount: size(principal) },
              { asset: feeAsset, amount: relayer },
          ]
        : [{ asset: deposited, amount: size(sum(principal, relayer)) }];
    const byToken: DepositPullEntry<A, T>[] = [];
    for (const pull of byAsset) {
        const token = pull.asset.token.toLowerCase();
        const seen = byToken.find((p) => p.asset.token.toLowerCase() === token);
        if (seen) seen.amount = sum(seen.amount, pull.amount);
        else byToken.push({ ...pull });
    }
    return {
        separateFee: separate ? feeAsset : undefined,
        feeSharesToken: byToken.length === 1,
        byAsset,
        byToken,
    };
}

/** Both figures summed, or `undefined` while either is: never a partial sum. */
function sum<T extends TokenAmount | undefined>(a: T, b: T): T {
    // `T` is `TokenAmount` when neither can be `undefined`, so the cast only
    // restates what the branch established.
    return (a === undefined || b === undefined ? undefined : branded<TokenAmount>(a + b)) as T;
}
