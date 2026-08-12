// Per-arity subpaths, not the `poseidon-lite` barrel. The barrel is CommonJS
// and re-exports all 16 arities through `Object.defineProperty` getters, which
// no bundler can analyse statically — importing it pulls every round-constant
// table (~604 KB minified). The subpaths pull only the arities named here
// (~161 KB). `bundle-budget.mjs` guards the difference.
import { poseidon1 } from "poseidon-lite/poseidon1";
import { poseidon2 } from "poseidon-lite/poseidon2";
import { poseidon3 } from "poseidon-lite/poseidon3";
import { poseidon4 } from "poseidon-lite/poseidon4";
import { poseidon5 } from "poseidon-lite/poseidon5";
import { poseidon6 } from "poseidon-lite/poseidon6";
import { poseidon7 } from "poseidon-lite/poseidon7";
import { poseidon8 } from "poseidon-lite/poseidon8";

export type Field = bigint;

// poseidon-lite exports a fixed-arity function per input width. Parity with
// circomlibjs `buildPoseidon` (BN254, iden3 constants) is verified by
// `poseidon.test.ts`. Arity ceiling 8 covers all in-tree callers.
const TABLE: Record<number, (xs: Field[]) => bigint> = {
    1: poseidon1 as (xs: Field[]) => bigint,
    2: poseidon2 as (xs: Field[]) => bigint,
    3: poseidon3 as (xs: Field[]) => bigint,
    4: poseidon4 as (xs: Field[]) => bigint,
    5: poseidon5 as (xs: Field[]) => bigint,
    6: poseidon6 as (xs: Field[]) => bigint,
    7: poseidon7 as (xs: Field[]) => bigint,
    8: poseidon8 as (xs: Field[]) => bigint,
};

export class Poseidon {
    private constructor() {}
    static async build(): Promise<Poseidon> {
        return new Poseidon();
    }
    hash(xs: Field[]): Field {
        const fn = TABLE[xs.length];
        if (!fn) throw new Error(`Poseidon arity ${xs.length} not supported (1..8)`);
        return fn(xs);
    }
}
