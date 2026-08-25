import { describe, expect, it } from "vitest";
import {
    type CircuitShape,
    coeffCount,
    shapeId,
    TRANSACT_2X2,
    TRANSACT_3X3,
    TRANSACT_4X4,
    TRANSACT_SHAPES,
} from "./shape.js";

// The counts are not free parameters: `@lelantos-org/circuits` publishes a
// `coeffCount` per circuit in `vectors/index.json`, and `PubInputs.compress`
// on chain emits exactly that many. `circuit/vectors.test.ts` reads the
// published values; these pin the closed form that has to reproduce them.
//
// Spelled out per shape rather than derived, because a table that recomputed
// `9 + 3·nIn + 8·nOut` would agree with `coeffCount` by construction and test
// nothing.
const PUBLISHED: readonly { shape: CircuitShape; id: string; coeffs: number }[] = [
    { shape: TRANSACT_2X2, id: "2x2", coeffs: 31 },
    { shape: TRANSACT_3X3, id: "3x3", coeffs: 42 },
    { shape: TRANSACT_4X4, id: "4x4", coeffs: 53 },
];

describe.each(PUBLISHED)("transact $id", ({ shape, id, coeffs }) => {
    it("emits the published coefficient count", () => {
        expect(coeffCount(shape)).toBe(coeffs);
    });

    it("names the artifact directory the circuits package builds", () => {
        expect(shapeId(shape)).toBe(id);
    });
});

describe("TRANSACT_SHAPES", () => {
    // The suites that iterate shapes read this list, so a shape missing from
    // it is a shape nothing covers — a silent gap rather than a failure.
    it("lists every published shape, narrowest first", () => {
        expect(TRANSACT_SHAPES.map(shapeId)).toEqual(PUBLISHED.map((p) => p.id));
    });
});

describe("coeffCount", () => {
    it("grows by 3 per input and 8 per output", () => {
        const base = coeffCount({ nIn: 2, nOut: 2 });
        expect(coeffCount({ nIn: 3, nOut: 2 })).toBe(base + 3);
        expect(coeffCount({ nIn: 2, nOut: 3 })).toBe(base + 8);
    });
});
