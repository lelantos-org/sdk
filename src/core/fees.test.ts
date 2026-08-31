import { describe, expect, it } from "vitest";
import { tokenAmount } from "./brand.js";
import { InvalidArgumentError } from "./errors.js";
import { depositCeiling, depositTotal, withdrawNet } from "./fees.js";
import { RAY } from "./units.js";

// `publicOut` is the GROSS: `MASP._unshieldLeg` skims the fee out of what
// leaves the pool rather than charging it on top. These pin the two branches
// against that contract behaviour, because using the wrong one misreports what
// the recipient gets.
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

    it("and the two branches are NOT interchangeable once rounding bites", () => {
        // ...but they round at different points, which is why the SDK has to
        // mirror the contract's branch rather than pick one.
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
        // The invariant a UI depends on: showing net and fee separately must
        // not leave a rounding crumb unaccounted for.
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

// The mirror image of `withdrawNet`: a shield is charged ON TOP of the
// principal, and its yield branch takes the fee in units before converting
// once. These pin both against what `MASP.deposit` actually pulls, because
// under-quoting here is not a rounding nit — the Permit2 pull is refused and
// the deposit reverts.
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

// Overshooting costs the payer nothing — Permit2 transfers only what the pool
// asks for, an allowance is a cap, and `NativeAdapter` refunds the unused
// `msg.value` — while undershooting reverts the deposit.
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
