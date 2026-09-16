// Wall-clock time in the unit on-chain deadlines use.

/**
 * The current Unix time in whole seconds, rounded down.
 *
 * The one reading of the clock for every deadline, allowance window and quote
 * age, so a test can pin it with `vi.setSystemTime`.
 */
export function unixNow(): number {
    return Math.floor(Date.now() / 1000);
}
