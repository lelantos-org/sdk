import { describe, expect, it } from "vitest";
import { withdrawNet } from "./fees.js";
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
