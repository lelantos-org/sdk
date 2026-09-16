// `grossForNet` inverts `withdrawNet`: the smallest gross whose net covers the target. Checked as a
// property over both fee branches, since the yield branch rounds its unit fee up before converting.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isWalletError } from "../errors/guard.js";
import { grossForNet, withdrawNet } from "./fees.js";
import { RAY } from "./units.js";

const params = fc.record({
    feeBps: fc.bigInt({ min: 0n, max: 9_999n }),
    scale: fc.constantFrom(1n, 7n, 1_000n, 10n ** 12n, 10n ** 15n),
    // Index at or above RAY (a yield position that has earned), and RAY itself.
    index: fc.oneof(fc.constant(RAY), fc.bigInt({ min: RAY, max: 3n * RAY })),
    yieldEnabled: fc.boolean(),
});

describe("grossForNet", () => {
    it("is the smallest gross whose net covers the target", () => {
        fc.assert(
            fc.property(params, fc.bigInt({ min: 1n, max: 10n ** 24n }), (p, net) => {
                const gross = grossForNet({ ...p, net });
                const at = (publicOut: bigint) => withdrawNet({ ...p, publicOut }).net;
                expect(at(gross)).toBeGreaterThanOrEqual(net);
                if (gross > 0n) expect(at(gross - 1n)).toBeLessThan(net);
            }),
            { numRuns: 400 },
        );
    });

    it("returns a gross's own figure when the target is a net withdrawNet produced", () => {
        fc.assert(
            fc.property(params, fc.bigInt({ min: 1n, max: 10n ** 12n }), (p, publicOut) => {
                const { net } = withdrawNet({ ...p, publicOut });
                const gross = grossForNet({ ...p, net });
                // Several grosses may share a net; the inverse picks the smallest.
                expect(gross).toBeLessThanOrEqual(publicOut);
                expect(withdrawNet({ ...p, publicOut: gross }).net).toBe(net);
            }),
            { numRuns: 400 },
        );
    });

    it("matches hand-computed figures on both branches", () => {
        // Plain, 20 bps, scale 1000: net(p) = p*1000 - floor(p*1000*20/10000).
        expect(grossForNet({ net: 998_000n, feeBps: 20n, scale: 1000n })).toBe(1000n);
        expect(grossForNet({ net: 998_001n, feeBps: 20n, scale: 1000n })).toBe(1001n);
        // Yield at RAY, 25 bps, scale 1: net(p) = p - ceil(p*25/10000).
        expect(grossForNet({ net: 399n, feeBps: 25n, scale: 1n, yieldEnabled: true })).toBe(400n);
    });

    it("is zero for a non-positive target", () => {
        expect(grossForNet({ net: 0n, feeBps: 20n, scale: 1n })).toBe(0n);
        expect(grossForNet({ net: -5n, feeBps: 20n, scale: 1n })).toBe(0n);
    });

    it("refuses a target no withdrawal can deliver", () => {
        let err: unknown;
        try {
            grossForNet({ net: 1n, feeBps: 10_000n, scale: 1n });
        } catch (e) {
            err = e;
        }
        expect(isWalletError(err, "INVALID_ARGUMENT")).toBe(true);
    });
});
