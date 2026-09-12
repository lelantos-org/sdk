import { describe, expect, it } from "vitest";
import {
    type CircuitShape,
    challengeWordCount,
    coeffCount,
    shapeId,
    TRANSACT_4X6,
    TRANSACT_SHAPES,
} from "./shape.js";

// The counts are not free parameters: `@lelantos-org/circuits` publishes both
// per circuit in `vectors/index.json`, and `PubInputs.compress` on chain hashes
// `challengeWords` and evaluates `coeffs`. `circuit/vectors.test.ts` reads the
// published values; these pin the closed forms that have to reproduce them.
//
// Two counts because the vectors are two: `challengeWords` is every logical
// public input, `coeffs` the subset the circuit constrains. The 23-word
// difference — the four address words, the clue triples, the aux digest — is
// hashed into `z` and never evaluated, because an unconstrained coefficient is
// a free variable a prover solves `y = Σ c[k]·z^k` with. See `coeffCount`.
//
// Spelled out per shape rather than derived, because a table that recomputed
// the closed forms would agree with them by construction and test nothing.
const PUBLISHED: readonly {
    shape: CircuitShape;
    id: string;
    coeffs: number;
    challenge: number;
}[] = [{ shape: TRANSACT_4X6, id: "4x6", coeffs: 46, challenge: 69 }];

describe.each(PUBLISHED)("transact $id", ({ shape, id, coeffs, challenge }) => {
    it("emits the published coefficient count", () => {
        expect(coeffCount(shape)).toBe(coeffs);
    });

    it("hashes the published challenge-word count", () => {
        expect(challengeWordCount(shape)).toBe(challenge);
    });

    it("evaluates strictly fewer words than it hashes", () => {
        expect(coeffCount(shape)).toBeLessThan(challengeWordCount(shape));
    });

    it("names the artifact directory the circuits package builds", () => {
        expect(shapeId(shape)).toBe(id);
    });
});

describe("TRANSACT_SHAPES", () => {
    // The suites that iterate shapes read this list, so a shape missing from
    // it is a shape nothing covers — a silent gap rather than a failure.
    it("lists every published shape", () => {
        expect(TRANSACT_SHAPES.map(shapeId)).toEqual(PUBLISHED.map((p) => p.id));
    });
});

describe("coeffCount", () => {
    it("grows by 3 per input and 5 per output", () => {
        const base = coeffCount({ nIn: 2, nOut: 2 });
        expect(coeffCount({ nIn: 3, nOut: 2 })).toBe(base + 3);
        expect(coeffCount({ nIn: 2, nOut: 3 })).toBe(base + 5);
    });
});

describe("challengeWordCount", () => {
    it("grows by 3 per input and 8 per output", () => {
        const base = challengeWordCount({ nIn: 2, nOut: 2 });
        expect(challengeWordCount({ nIn: 3, nOut: 2 })).toBe(base + 3);
        expect(challengeWordCount({ nIn: 2, nOut: 3 })).toBe(base + 8);
    });

    it("grows by 3 more per output than the coefficient count", () => {
        // The three clue slots. A fourth per-output challenge word without a
        // constraint would widen this gap; a fourth COEFFICIENT would be a free
        // variable.
        const dCoeff = coeffCount({ nIn: 2, nOut: 3 }) - coeffCount({ nIn: 2, nOut: 2 });
        const dChallenge =
            challengeWordCount({ nIn: 2, nOut: 3 }) - challengeWordCount({ nIn: 2, nOut: 2 });
        expect(dChallenge - dCoeff).toBe(3);
    });
});
