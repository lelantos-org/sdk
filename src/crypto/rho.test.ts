import { describe, expect, it } from "vitest";
import { Poseidon } from "./poseidon.js";
import { buildRho } from "./rho.js";
import { TAG_RHO } from "./tags.js";

// buildRho must mirror DeriveRho in circuits/src/lib/note.circom:
//   rho = Poseidon(TAG_RHO, nf0, index)
describe("buildRho", () => {
    it("equals Poseidon(TAG_RHO, nf0, index)", async () => {
        const P = await Poseidon.build();
        const nf0 = 123456789n;
        for (const index of [0, 1]) {
            expect(buildRho(P, nf0, index)).toBe(P.hash([TAG_RHO, nf0, BigInt(index)]));
        }
    });

    it("distinguishes the two output slots (no shared rho)", async () => {
        const P = await Poseidon.build();
        const nf0 = 987654321n;
        expect(buildRho(P, nf0, 0)).not.toBe(buildRho(P, nf0, 1));
    });

    it("accepts number or bigint index identically", async () => {
        const P = await Poseidon.build();
        const nf0 = 42n;
        expect(buildRho(P, nf0, 1)).toBe(buildRho(P, nf0, 1n));
    });
});
