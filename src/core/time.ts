// Wall-clock time in the unit on-chain deadlines use.

/** The current Unix time in whole seconds, rounded down. */
export function unixNow(): number {
    return Math.floor(Date.now() / 1000);
}
