import { describe, expect, it } from "vitest";
import { tokenAmount } from "../core/brand.js";
import { InvalidArgumentError } from "../errors/config.js";
import {
    applyFee,
    depositCeiling,
    depositTotal,
    depositTotals,
    unitFee,
    withdrawNet,
} from "./fees.js";
import { RAY } from "./units.js";

// `Fees.unitFee` on chain. A yield asset charges in normalized units, where a
// floored fee is zero below `BPS_DENOMINATOR / feeBps` units, and a quote one
// unit short is a Permit2 pull the pool refuses.
describe("unitFee", () => {
    it("agrees with the floored fee when the division is exact", () => {
        expect(unitFee(1_000_000n, 20n)).toBe(2_000n);
        expect(unitFee(1_000_000n, 20n)).toBe(applyFee(1_000_000n, 20n));
    });

    it("rounds up the moment it is inexact", () => {
        expect(unitFee(1_000_001n, 20n)).toBe(2_001n); // floors to 2_000
        expect(unitFee(1n, 20n)).toBe(1n); // floors to 0
    });

    it("charges nothing at a zero rate or a zero amount", () => {
        expect(unitFee(1_000_000n, 0n)).toBe(0n);
        expect(unitFee(0n, 20n)).toBe(0n);
    });

    it("never undercharges relative to the floored fee, nor by more than a unit", () => {
        for (const units of [0n, 1n, 7n, 399n, 400n, 401n, 1_000_003n]) {
            for (const bps of [0n, 1n, 20n, 25n, 2_000n]) {
                const floored = applyFee(units, bps);
                expect(unitFee(units, bps)).toBeGreaterThanOrEqual(floored);
                expect(unitFee(units, bps)).toBeLessThanOrEqual(floored + 1n);
            }
        }
    });
});

// `publicOut` is the GROSS: `MASP._unshieldLeg` skims the fee out of what
// leaves the pool rather than charging it on top. These pin both branches
// against that contract behaviour; the wrong branch misreports what the
// recipient gets.
describe("withdrawNet", () => {
    const D = 1_000_000_000n; // a USDC denomination, scale 1
    const BPS = 20n; // 0.2%, the deployed rate on every asset

    it("skims the fee out of the gross, never adding it on top", () => {
        // 1000 USDC out of the pool delivers 998.
        expect(withdrawNet({ publicOut: D, feeBps: BPS, scale: 1n }).net).toBe(998_000_000n);
        expect(withdrawNet({ publicOut: D, feeBps: BPS, scale: 1n }).net).toBeLessThan(D);
    });

    it("is the full amount at a zero rate", () => {
        expect(withdrawNet({ publicOut: D, feeBps: 0n, scale: 1n }).net).toBe(D);
    });

    it("scales an 18-decimal asset through `scale`", () => {
        // WETH: 1e8 circuit units is 1 WETH at scale 1e10.
        expect(
            withdrawNet({ publicOut: 100_000_000n, feeBps: 0n, scale: 10_000_000_000n }).net,
        ).toBe(10n ** 18n);
    });

    it("grows the net with the index, the denomination unchanged", () => {
        expect(
            withdrawNet({ publicOut: D, feeBps: 0n, scale: 1n, index: (RAY * 105n) / 100n }).net,
        ).toBe(1_050_000_000n);
    });

    it("charges a yield asset's fee in normalized units, before conversion", () => {
        // The plain branch converts then skims; the yield branch skims then
        // converts. At a unity index and these values they agree...
        expect(withdrawNet({ publicOut: D, feeBps: BPS, scale: 1n, yieldEnabled: true }).net).toBe(
            998_000_000n,
        );
        expect(withdrawNet({ publicOut: D, feeBps: BPS, scale: 1n, yieldEnabled: false }).net).toBe(
            998_000_000n,
        );
    });

    it("rounds a yield asset's unit fee up, as `Fees.unitFee` does", () => {
        // 1 unit at 20 bps is 0.002 units of fee: the pool still charges one,
        // so the recipient gets nothing rather than the whole unit back.
        expect(withdrawNet({ publicOut: 1n, feeBps: BPS, scale: 1n, yieldEnabled: true })).toEqual({
            net: 0n,
            fee: 1n,
        });
        // The plain branch floors on the converted amount, so it keeps it.
        const plain = withdrawNet({ publicOut: 1n, feeBps: BPS, scale: 1n, yieldEnabled: false });
        expect(plain).toEqual({ net: 1n, fee: 0n });
    });

    it("and the two branches are NOT interchangeable once rounding bites", () => {
        // ...but they round at different points, so the SDK must mirror the
        // contract's branch rather than pick one.
        const odd = 1_000_000_003n;
        const idx = (RAY * 10n) / 3n; // 3.333… — deliberately inexact
        const plain = withdrawNet({
            publicOut: odd,
            feeBps: BPS,
            scale: 7n,
            index: idx,
            yieldEnabled: false,
        });
        const yielded = withdrawNet({
            publicOut: odd,
            feeBps: BPS,
            scale: 7n,
            index: idx,
            yieldEnabled: true,
        });
        expect(plain.net).not.toBe(yielded.net);
    });
});

describe("withdrawNet fee accounting", () => {
    it("net and fee always sum to the gross, on both branches", () => {
        // A UI showing net and fee separately must not leave a rounding
        // remainder unaccounted for.
        for (const yieldEnabled of [false, true]) {
            for (const index of [RAY, (RAY * 105n) / 100n, (RAY * 10n) / 3n]) {
                const { net, fee } = withdrawNet({
                    publicOut: 1_000_000_003n,
                    feeBps: 20n,
                    scale: 7n,
                    index,
                    yieldEnabled,
                });
                const gross = (1_000_000_003n * 7n * index) / RAY;
                expect(net + fee).toBe(gross);
            }
        }
    });
});

// Mirror image of `withdrawNet`: a shield is charged ON TOP of the principal,
// and its yield branch takes the fee in units before converting once. These pin
// both against what `MASP.deposit` pulls; under-quoting makes Permit2 refuse the
// pull and the deposit revert.
describe("depositTotal", () => {
    const N = 1_000_000n; // circuit units
    const BPS = 20n; // 0.2%, the deployed rate

    it("charges the fee on top of the principal, not out of it", () => {
        const total = depositTotal({ publicIn: N, feeIn: 0n, depositBps: BPS, scale: 1n });
        expect(total).toBe(N + 2_000n);
        expect(total).toBeGreaterThan(N);
    });

    it("funds the relayer's note as well as the principal", () => {
        const withFee = depositTotal({ publicIn: N, feeIn: 500n, depositBps: 0n, scale: 1n });
        expect(withFee).toBe(N + 500n);
    });

    // The pool takes the fee in units and converts the total once, so the
    // result is not `plainTotal * index` — it rounds at a different point.
    it("takes a yield asset's fee in units and converts the total once", () => {
        // gross/supply = 1.1: the venue has earned 10%.
        const rate = { gross: 1_100_000n, supply: 1_000_000n };
        const total = depositTotal({
            publicIn: N,
            feeIn: 0n,
            depositBps: BPS,
            scale: 1n,
            yieldEnabled: true,
            rate,
        });
        // ceil((1_000_000 + 2_000) * 1_100_000 / 1_000_000)
        expect(total).toBe(1_102_200n);
    });

    it("rounds a yield charge up, never down", () => {
        // A ratio that cannot divide evenly, so the direction is observable.
        const rate = { gross: 1_000_003n, supply: 1_000_000n };
        const total = depositTotal({
            publicIn: 7n,
            feeIn: 0n,
            depositBps: 0n,
            scale: 1n,
            yieldEnabled: true,
            rate,
        });
        // 7 * 1_000_003 / 1_000_000 = 7.000021 → 8, so the payer covers it.
        expect(total).toBe(8n);
    });

    // `YieldOps._deposit` sizes the escrow with `Fees.unitFee`, so a quote that
    // floors is short by a unit and the Permit2 pull reverts.
    it("rounds a yield asset's unit fee up before converting", () => {
        const rate = { gross: 1_000_000n, supply: 1_000_000n }; // unity: isolate the fee
        const total = depositTotal({
            publicIn: 1n,
            feeIn: 0n,
            depositBps: BPS,
            scale: 1n,
            yieldEnabled: true,
            rate,
        });
        expect(total).toBe(2n); // 1 principal + ceil(1 * 20 / 10_000) = 1
        // The plain branch floors on the converted amount, and charges nothing.
        expect(depositTotal({ publicIn: 1n, feeIn: 0n, depositBps: BPS, scale: 1n })).toBe(1n);
    });

    it("is the plain arithmetic when the venue has earned nothing yet", () => {
        const rate = { gross: 0n, supply: 0n };
        const yielded = depositTotal({
            publicIn: N,
            feeIn: 0n,
            depositBps: BPS,
            scale: 10n,
            yieldEnabled: true,
            rate,
        });
        expect(yielded).toBe(depositTotal({ publicIn: N, feeIn: 0n, depositBps: BPS, scale: 10n }));
    });

    // `scale` is not a conservative fallback: it under-quotes by exactly what
    // the venue has earned, which is the amount that makes the pull revert.
    it("refuses to quote a yield asset with no reported rate", () => {
        expect(() =>
            depositTotal({
                publicIn: N,
                feeIn: 0n,
                depositBps: BPS,
                scale: 1n,
                yieldEnabled: true,
            }),
        ).toThrow(InvalidArgumentError);
    });
});

// Per-token split, as `MASP._quoteShield` prices it: a relayer note in another
// asset leaves the principal's quote entirely and is pulled at `feeIn *
// feeScale`; one in the deposit asset is part of a single pull whose total the
// split must still add up to.
describe("depositTotals", () => {
    const N = 1_000_000n;
    const BPS = 20n;
    const SAME = { publicAssetId: 1n, feeAssetId: 1n };
    const APART = { publicAssetId: 1n, feeAssetId: 2n };

    it("prices a note in another asset under that asset's scale, apart", () => {
        const t = depositTotals({
            publicIn: N,
            feeIn: 7n,
            depositBps: BPS,
            scale: 10n,
            feeScale: 10_000n,
            ...APART,
        });
        expect(t.principal).toBe(N * 10n + 20_000n);
        // The deposit's `scale` would under-price it a thousandfold.
        expect(t.relayer).toBe(70_000n);
    });

    it("keeps a cross-asset note out of a yield principal's unit quote", () => {
        const rate = { gross: 1_100_000n, supply: 1_000_000n };
        const t = depositTotals({
            publicIn: N,
            feeIn: 500n,
            depositBps: BPS,
            scale: 1n,
            yieldEnabled: true,
            rate,
            feeScale: 3n,
            ...APART,
        });
        // Same as a zero-fee yield quote: no fee units join `totalNormalized`.
        expect(t.principal).toBe(
            depositTotal({
                publicIn: N,
                feeIn: 0n,
                depositBps: BPS,
                scale: 1n,
                yieldEnabled: true,
                rate,
            }),
        );
        expect(t.relayer).toBe(1_500n);
    });

    it("sums to the single pull when the note is in the deposit asset", () => {
        const plain = { publicIn: N, feeIn: 500n, depositBps: BPS, scale: 10n };
        const p = depositTotals({ ...plain, ...SAME });
        expect(p.relayer).toBe(5_000n);
        expect(p.principal + p.relayer).toBe(depositTotal(plain));

        // On a yield asset the pool converts principal, fee and note once, so
        // the note's share is whatever it adds to that rounding.
        const rate = { gross: 1_000_003n, supply: 1_000_000n };
        const yielded = {
            publicIn: 7n,
            feeIn: 3n,
            depositBps: 0n,
            scale: 1n,
            yieldEnabled: true,
            rate,
        };
        const y = depositTotals({ ...yielded, ...SAME });
        expect(y.principal + y.relayer).toBe(depositTotal(yielded));
        expect(y.principal).toBe(8n);
        expect(y.relayer).toBe(3n);
    });

    it("keeps a zero fee on the single-token path whatever asset is named", () => {
        const t = depositTotals({ publicIn: N, feeIn: 0n, depositBps: 0n, scale: 1n, ...APART });
        expect(t).toEqual({ principal: N, relayer: 0n });
    });

    it("ignores feeScale for a note in the deposited asset", () => {
        const args = { publicIn: N, feeIn: 500n, depositBps: BPS, scale: 10n };
        const t = depositTotals({ ...args, feeScale: 1_000n, ...SAME });
        expect(t.relayer).toBe(5_000n);
        expect(t.principal + t.relayer).toBe(depositTotal(args));
    });

    it("refuses a separate note without feeScale", () => {
        expect(() =>
            depositTotals({ publicIn: N, feeIn: 500n, depositBps: BPS, scale: 10n, ...APART }),
        ).toThrow(InvalidArgumentError);
    });
});

// Overshooting costs the payer nothing (Permit2 transfers only what the pool
// asks for, an allowance is a cap, and `NativeAdapter` refunds unused
// `msg.value`), while undershooting reverts the deposit.
describe("depositCeiling", () => {
    it("signs a plain asset's cost exactly", () => {
        expect(depositCeiling(tokenAmount(1_000_000n), false)).toBe(1_000_000n);
    });

    it("leaves a yield asset room for the index to move before inclusion", () => {
        const quoted = tokenAmount(1_000_000n);
        const ceiling = depositCeiling(quoted, true);
        expect(ceiling).toBeGreaterThan(quoted);
        expect(ceiling).toBe(1_005_000n); // 50 bps
    });
});
