import { describe, expect, it } from "vitest";
import { Poseidon } from "./poseidon.js";

// Vectors generated from circomlibjs `buildPoseidon` (BN254, iden3 default
// constants). Locks the in-tree Poseidon impl (`poseidon-lite`) to the
// circuit-side reference.
const VECTORS: ReadonlyArray<{ inputs: bigint[]; expected: bigint }> = [
    {
        inputs: [20n, 27n],
        expected: 16753536757606073812047204240417124903990020966342214690253096050498692226182n,
    },
    {
        inputs: [20n, 27n, 34n],
        expected: 5689948056774891962716013699936559859895763574854535072638209290403348277172n,
    },
    {
        inputs: [20n, 27n, 34n, 41n],
        expected: 18345834672513882401805278201051116276519620548311011488340543344980467512741n,
    },
    {
        inputs: [20n, 27n, 34n, 41n, 48n],
        expected: 173911280781113407141402743082392048924281365243741084798356195969249828260n,
    },
    {
        inputs: [20n, 27n, 34n, 41n, 48n, 55n],
        expected: 21146714884894841152167447491286077228765324377412389795272009936051945059771n,
    },
];

describe("Poseidon", () => {
    it("matches circomlibjs vectors for arities 2..6", async () => {
        const P = await Poseidon.build();
        for (const v of VECTORS) {
            expect(P.hash(v.inputs), `arity ${v.inputs.length}`).toBe(v.expected);
        }
    });

    it("throws for unsupported arity", async () => {
        const P = await Poseidon.build();
        expect(() => P.hash([])).toThrow(/arity 0 not supported/);
        expect(() => P.hash(new Array(9).fill(1n))).toThrow(/arity 9 not supported/);
    });
});
