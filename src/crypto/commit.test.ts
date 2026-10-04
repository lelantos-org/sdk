// Note commitments against the golden vectors shipped by `@lelantos-org/circuits`.
//
// The vectors' intermediates come from the circuits repo's reference implementation and their
// witnesses are accepted by the compiled circuits, so a mismatch here is a commitment the deployed
// verifier rejects.

import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { POW_2_64 } from "../core/field.js";
import { buildInner, buildNoteCommitment, commitWithInner } from "./commit.js";
import { buildNullifierFromNsk } from "./nullifier.js";
import { Poseidon } from "./poseidon.js";
import * as tags from "./tags.js";

interface TransactVectors {
    schema: string;
    constants: { tags: Record<string, string> };
    vectors: {
        name: string;
        intermediates: {
            inputs: { slot: number; isDummy: boolean; inner: string; cm: string; nf: string }[];
            outputs: { slot: number; inner: string; cm: string }[];
        };
        witness: Record<
            | "in_asset"
            | "in_value"
            | "in_pk"
            | "in_rho"
            | "in_rcm"
            | "in_nsk"
            | "out_asset"
            | "out_value"
            | "out_pk"
            | "out_rho"
            | "out_rcm",
            string[]
        >;
    }[];
}

interface BatchVectors {
    schema: string;
    vectors: {
        name: string;
        intermediates: {
            leaves: {
                cms: string;
                leaf: string;
                leafAsset: string;
                leafPublicIn: string;
                isDeposit: number;
                note: Record<"asset" | "value" | "pk" | "rho" | "rcm" | "inner", string>;
            }[];
        };
    }[];
}

type BatchLeaf = BatchVectors["vectors"][number]["intermediates"]["leaves"][number];

function noteOf(leaf: BatchLeaf) {
    return {
        asset: BigInt(leaf.note.asset),
        value: BigInt(leaf.note.value),
        pk: BigInt(leaf.note.pk),
        rho: BigInt(leaf.note.rho),
        rcm: BigInt(leaf.note.rcm),
    };
}

/** Witness word `i` of `xs`; a missing slot fails the test instead of hashing `undefined`. */
function word(xs: readonly string[], i: number): bigint {
    const x = xs[i];
    if (x === undefined) throw new Error(`vector has no slot ${i}`);
    return BigInt(x);
}

const require = createRequire(import.meta.url);
const transact = require("@lelantos-org/circuits/vectors/transact-4x6.json") as TransactVectors;
const batch = require("@lelantos-org/circuits/vectors/tree-update-batch-8.json") as BatchVectors;

describe("note commitment vectors", () => {
    let P: Poseidon;
    beforeAll(async () => {
        P = await Poseidon.build();
    });

    it("reads the schema it was written against", () => {
        expect(transact.schema).toBe("lelantos.circuits.vectors/2");
        expect(batch.schema).toBe("lelantos.circuits.vectors/2");
    });

    it("has the circuit's tag table", () => {
        const circuit = transact.constants.tags;
        for (const [name, value] of Object.entries(circuit)) {
            expect((tags as Record<string, bigint>)[name], name).toBe(BigInt(value));
        }
        // Off-circuit tags must not reuse a circuit value.
        const values = Object.values(tags);
        expect(new Set(values).size).toBe(values.length);
    });

    it.each(
        transact.vectors.map((v) => [v.name, v] as const),
    )("%s: input inner, cm and nf", (_name, v) => {
        const w = v.witness;
        let real = 0;
        for (const input of v.intermediates.inputs) {
            const i = input.slot;
            const note = {
                asset: word(w.in_asset, i),
                value: word(w.in_value, i),
                pk: word(w.in_pk, i),
                rho: word(w.in_rho, i),
                rcm: word(w.in_rcm, i),
            };
            const cm = buildNoteCommitment(P, note);
            expect(buildInner(P, note), `inner ${i}`).toBe(BigInt(input.inner));
            expect(cm, `cm ${i}`).toBe(BigInt(input.cm));
            expect(buildNullifierFromNsk(P, word(w.in_nsk, i), note.rho, cm), `nf ${i}`).toBe(
                BigInt(input.nf),
            );
            if (!input.isDummy) real++;
        }
        expect(real).toBeGreaterThan(0);
    });

    it.each(
        transact.vectors.map((v) => [v.name, v] as const),
    )("%s: output inner and cm", (_name, v) => {
        const w = v.witness;
        expect(v.intermediates.outputs.length).toBeGreaterThan(0);
        for (const output of v.intermediates.outputs) {
            const j = output.slot;
            const note = {
                asset: word(w.out_asset, j),
                value: word(w.out_value, j),
                pk: word(w.out_pk, j),
                rho: word(w.out_rho, j),
                rcm: word(w.out_rcm, j),
            };
            expect(buildInner(P, note), `inner ${j}`).toBe(BigInt(output.inner));
            expect(buildNoteCommitment(P, note), `cm ${j}`).toBe(BigInt(output.cm));
        }
    });

    it("builds a deposit leaf from its published inner", () => {
        const deposits = batch.vectors.flatMap((v) =>
            v.intermediates.leaves.filter((l) => l.isDeposit === 1),
        );
        expect(deposits.length).toBeGreaterThan(0);
        for (const leaf of deposits) {
            const asset = BigInt(leaf.leafAsset);
            const value = BigInt(leaf.leafPublicIn);
            // A deposit's `cms` word is `inner`; the leaf is the commitment built from it.
            expect(commitWithInner(P, asset, value, BigInt(leaf.cms))).toBe(BigInt(leaf.leaf));
            expect(buildInner(P, noteOf(leaf))).toBe(BigInt(leaf.cms));
            expect(buildNoteCommitment(P, { ...noteOf(leaf), asset, value })).toBe(
                BigInt(leaf.leaf),
            );
        }
    });

    it("builds a spend leaf as the note commitment itself", () => {
        const spends = batch.vectors.flatMap((v) =>
            v.intermediates.leaves.filter((l) => l.isDeposit === 0),
        );
        expect(spends.length).toBeGreaterThan(0);
        for (const leaf of spends) {
            expect(leaf.cms).toBe(leaf.leaf);
            expect(buildNoteCommitment(P, noteOf(leaf))).toBe(BigInt(leaf.leaf));
        }
    });
});

describe("commitWithInner range checks", () => {
    let P: Poseidon;
    beforeAll(async () => {
        P = await Poseidon.build();
    });

    // `asset·2^64 + value` is injective only below 2^64: (0, 2^64) and (1, 0) pack alike.
    it("rejects an asset or value of 64 bits or more", () => {
        expect(() => commitWithInner(P, POW_2_64, 0n, 1n)).toThrow(/asset/);
        expect(() => commitWithInner(P, 0n, POW_2_64, 1n)).toThrow(/value/);
        expect(() => commitWithInner(P, POW_2_64 - 1n, POW_2_64 - 1n, 1n)).not.toThrow();
    });
});
