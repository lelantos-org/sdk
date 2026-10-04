import { describe, expect, it } from "vitest";
import { ProverArtifactsMissingError } from "../errors/prover.js";
import {
    type CircuitShape,
    challengeWordCount,
    coeffCount,
    DEFAULT_SHAPE,
    shapeId,
    TRANSACT_4X6,
    TRANSACT_SHAPES,
} from "./shape.js";

// `@lelantos-org/circuits` publishes both counts per circuit in `vectors/transact-4x6.json`
// (`coeffCount`, `challengeWords`), and `PubInputs.compress` on chain hashes
// `TRANSACT_CHALLENGE_WORDS` and evaluates `TRANSACT_COEFFS`. `circuit/vectors.test.ts` reads the
// published values; these pin the closed forms that have to reproduce them.
//
// `challengeWords` is every logical public input, `coeffs` the subset the circuit has signals
// for. The 25-word difference (the digest word, the five words after it, the clue triples, the
// aux digest) is hashed into `z` and never evaluated. See `coeffCount`.
//
// Spelled out per shape, not derived: a table that recomputed the closed forms would agree with
// them by construction.
const PUBLISHED: readonly {
    shape: CircuitShape;
    id: string;
    coeffs: number;
    challenge: number;
}[] = [{ shape: TRANSACT_4X6, id: "4x6", coeffs: 13, challenge: 38 }];

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
    // The suites that iterate shapes read this list, so a shape missing from it is covered by none.
    it("lists every published shape", () => {
        expect(TRANSACT_SHAPES.map(shapeId)).toEqual(PUBLISHED.map((p) => p.id));
    });
});

describe("coeffCount", () => {
    it("grows by 1 per input and 1 per output", () => {
        // A nullifier per input, a commitment per output.
        const base = coeffCount({ nIn: 2, nOut: 2 });
        expect(coeffCount({ nIn: 3, nOut: 2 })).toBe(base + 1);
        expect(coeffCount({ nIn: 2, nOut: 3 })).toBe(base + 1);
    });
});

describe("challengeWordCount", () => {
    it("grows by 1 per input and 4 per output", () => {
        const base = challengeWordCount({ nIn: 2, nOut: 2 });
        expect(challengeWordCount({ nIn: 3, nOut: 2 })).toBe(base + 1);
        expect(challengeWordCount({ nIn: 2, nOut: 3 })).toBe(base + 4);
    });

    it("grows by 3 more per output than the coefficient count", () => {
        // The three clue slots: per-output words with no circuit signal.
        const dCoeff = coeffCount({ nIn: 2, nOut: 3 }) - coeffCount({ nIn: 2, nOut: 2 });
        const dChallenge =
            challengeWordCount({ nIn: 2, nOut: 3 }) - challengeWordCount({ nIn: 2, nOut: 2 });
        expect(dChallenge - dCoeff).toBe(3);
    });
});

describe("ProverArtifactsMissingError default shape", () => {
    // `errors/` may not import `protocol/`, so the error spells the default as a literal.
    it("matches shapeId(DEFAULT_SHAPE)", () => {
        expect(new ProverArtifactsMissingError([]).shape).toBe(shapeId(DEFAULT_SHAPE));
    });
});
