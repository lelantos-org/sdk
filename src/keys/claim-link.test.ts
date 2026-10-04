import { describe, expect, it } from "vitest";
import { BABYJUB_SUBGROUP_ORDER } from "../core/field.js";
import { deriveClaimLinkNsk } from "./claim-link.js";

// A link's key is recomputed from the sender's seed to take an unclaimed link back, so any drift
// in the derivation strands those funds.

describe("deriveClaimLinkNsk", () => {
    it("is a fixed function of the sender's key, the chain and the index", () => {
        const key = deriveClaimLinkNsk(7n, 8453n, 3);
        expect(deriveClaimLinkNsk(7n, 8453n, 3)).toBe(key);
        expect(key).toBeGreaterThan(0n);
        expect(key).toBeLessThan(BABYJUB_SUBGROUP_ORDER);
    });

    it("matches its recorded vector", () => {
        expect(deriveClaimLinkNsk(1n, 1n, 0).toString()).toMatchInlineSnapshot(
            `"1963239671568623884075476309413718713304961047300345352604558127705017098053"`,
        );
        expect(deriveClaimLinkNsk(7n, 8453n, 3).toString()).toMatchInlineSnapshot(
            `"2103788491683397230026798250025594175497045617041125163989572486931844189130"`,
        );
    });

    it("gives every sender, chain and index its own key", () => {
        const keys = [
            deriveClaimLinkNsk(7n, 8453n, 0),
            deriveClaimLinkNsk(7n, 8453n, 1),
            deriveClaimLinkNsk(7n, 1n, 0),
            deriveClaimLinkNsk(8n, 8453n, 0),
        ];
        expect(new Set(keys).size).toBe(keys.length);
    });

    it("is never the sender's own key", () => {
        expect(deriveClaimLinkNsk(7n, 8453n, 0)).not.toBe(7n);
    });

    it("refuses an index outside [0, 2^31) and a zero key", () => {
        for (const index of [-1, 1.5, 2 ** 31, Number.NaN]) {
            expect(() => deriveClaimLinkNsk(7n, 1n, index)).toThrow(/index/);
        }
        expect(() => deriveClaimLinkNsk(0n, 1n, 0)).toThrow();
    });
});
