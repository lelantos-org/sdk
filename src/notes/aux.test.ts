// The clue's subgroup witness.
//
// The pool accepts a clue `R` only with a point `Q` it can double three times
// onto `R`. `clueSubgroupWitness` derives `Q = [8^-1]R`.

import { beforeAll, describe, expect, it } from "vitest";
import { BABYJUB_INV8, BABYJUB_SUBGROUP_ORDER } from "../core/field.js";
import type { Point } from "../crypto/jubjub.js";
import { Jubjub } from "../crypto/jubjub-wasm/index.js";
import { clueSubgroupWitness } from "./aux.js";

describe("clueSubgroupWitness", () => {
    let J: Jubjub;

    beforeAll(async () => {
        J = await Jubjub.build();
    });

    /** `[8]p` by doubling, as `BabyJubJub.isEightfold` computes it. */
    const times8 = (p: Point): Point => {
        let acc = p;
        for (let i = 0; i < 3; i++) acc = J.addPoint(acc, acc);
        return acc;
    };

    it("pins 8^-1 modulo the subgroup order", () => {
        expect((8n * BABYJUB_INV8) % BABYJUB_SUBGROUP_ORDER).toBe(1n);
        expect(J.order).toBe(BABYJUB_SUBGROUP_ORDER);
    });

    it("doubles three times onto the clue point", () => {
        for (const r of [1n, 2n, 777n, BABYJUB_SUBGROUP_ORDER - 1n]) {
            const R = J.mulPointEscalar(J.base8, r);
            const Q = clueSubgroupWitness(J, R);
            expect(J.inSubgroup(Q)).toBe(true);
            expect(times8(Q)).toEqual(R);
        }
    });
});
