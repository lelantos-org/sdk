// Ordering helpers for values `Array.prototype.sort` cannot order itself.

/**
 * `Array.prototype.sort` comparator for `bigint`.
 *
 * `sort` stringifies by default, and `a - b` yields a `bigint` where it
 * requires a `number`.
 */
export function cmpBigint(a: bigint, b: bigint): number {
    return a < b ? -1 : a > b ? 1 : 0;
}
