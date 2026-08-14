import { describe, expect, it } from "vitest";
import { applyFee } from "../core/fees.js";
import { sizeBNote } from "./swap.js";

// `SwapWrapper` accepts the deposit leg only when the pool's Permit2 pull
// lands inside a window: at least `minOut` (`MaspPullBelowMinOut`) and no more
// than the venue actually returned (`MaspPullExceedsActualOut`). Sizing the B
// note is therefore a two-sided problem, and the obvious closed form solves
// only the upper half — it floor-divides, so the pull comes out one unit short
// and the swap reverts on-chain after a full Groth16.

/** What `MASP.deposit*` pulls for a B note of `v`: principal + floored fee. */
const pullFor = (v: bigint, scale: bigint, feeBps: bigint): bigint => {
    const inAmt = v * scale;
    return inAmt + applyFee(inAmt, feeBps);
};

const FEE_BPS = 500n; // 5%, as deployed in the e2e stack

describe("sizeBNote", () => {
    /// The exact case that reverted end-to-end: 8-decimal asset (scale 1) at
    /// 5% fee. The closed form yields 89 → pull 93 against a minOut of 94.
    it("covers minOut where the closed form falls one short", () => {
        const minOut = 94n;
        const closedForm = (minOut * 10_000n) / (1n * (10_000n + FEE_BPS));
        expect(pullFor(closedForm, 1n, FEE_BPS)).toBe(93n); // the old behaviour
        expect(closedForm).toBe(89n);

        const v = sizeBNote(minOut, 1n, FEE_BPS);
        expect(v).toBe(90n);
        expect(pullFor(v, 1n, FEE_BPS)).toBe(94n);
    });

    /// The property that matters, over the range where flooring bites.
    it("always covers minOut, and never by more than necessary", () => {
        for (const scale of [1n, 10n, 10_000_000_000n]) {
            for (let minOut = 1n; minOut <= 400n; minOut += 1n) {
                const v = sizeBNote(minOut, scale, FEE_BPS);
                expect(
                    pullFor(v, scale, FEE_BPS),
                    `pull must cover minOut=${minOut} scale=${scale}`,
                ).toBeGreaterThanOrEqual(minOut);
                // Minimal: one step down must not still cover it. Minimality
                // is what keeps the pull under `actualOut`.
                if (v > 0n) {
                    expect(
                        pullFor(v - 1n, scale, FEE_BPS),
                        `v=${v} is not minimal for minOut=${minOut} scale=${scale}`,
                    ).toBeLessThan(minOut);
                }
            }
        }
    });

    it("is exact when the fee divides cleanly", () => {
        // 100 principal + 5 fee = 105, hit exactly.
        expect(sizeBNote(105n, 1n, FEE_BPS)).toBe(100n);
        expect(pullFor(100n, 1n, FEE_BPS)).toBe(105n);
    });

    it("handles a zero fee", () => {
        expect(sizeBNote(250n, 1n, 0n)).toBe(250n);
        expect(pullFor(250n, 1n, 0n)).toBe(250n);
    });

    /// A minOut below one scaled unit cannot be represented; the caller turns
    /// this into an `InvalidArgumentError` rather than escrowing nothing.
    it("returns zero when minOut is below one scaled unit", () => {
        expect(sizeBNote(0n, 10n, FEE_BPS)).toBe(0n);
    });
});
