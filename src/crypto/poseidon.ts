// @ts-expect-error — circomlibjs ships without TS types
import { buildPoseidon } from "circomlibjs";

export type Field = bigint;

export class Poseidon {
    private p: any;
    private constructor(p: any) {
        this.p = p;
    }
    static async build(): Promise<Poseidon> {
        return new Poseidon(await buildPoseidon());
    }
    hash(xs: Field[]): Field {
        return BigInt(this.p.F.toObject(this.p(xs)));
    }
}
