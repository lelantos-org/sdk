import { describe, expect, it } from "vitest";
import { coeffCount, shapeId, TRANSACT_2X2, TRANSACT_3X3 } from "./shape.js";

// The counts are not free parameters: `@lelantos-org/circuits` publishes a
// `coeffCount` per circuit in `vectors/index.json`, and `PubInputs.compress`
// on chain emits exactly that many. `circuit/vectors.test.ts` reads the
// published values; these pin the closed form that has to reproduce them.

describe("coeffCount", () => {
    it("matches the published counts for both shapes", () => {
        expect(coeffCount(TRANSACT_2X2)).toBe(31);
        expect(coeffCount(TRANSACT_3X3)).toBe(42);
    });

    it("grows by 3 per input and 8 per output", () => {
        const base = coeffCount({ nIn: 2, nOut: 2 });
        expect(coeffCount({ nIn: 3, nOut: 2 })).toBe(base + 3);
        expect(coeffCount({ nIn: 2, nOut: 3 })).toBe(base + 8);
    });
});

describe("shapeId", () => {
    it("names the artifact directory the circuits package builds", () => {
        expect(shapeId(TRANSACT_2X2)).toBe("2x2");
        expect(shapeId(TRANSACT_3X3)).toBe("3x3");
    });
});
