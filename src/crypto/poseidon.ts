import {
    poseidon1,
    poseidon2,
    poseidon3,
    poseidon4,
    poseidon5,
    poseidon6,
    poseidon7,
    poseidon8,
} from "poseidon-lite";

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
