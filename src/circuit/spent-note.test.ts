import { beforeAll, describe, expect, it } from "vitest";
import { randomFr } from "../core/random.js";
import {
    buildNoteCommitment,
    buildNullifierFromNsk,
    derivePk,
    Poseidon,
    TAG_CM,
    TAG_INNER,
    TAG_NF,
    TAG_NK,
} from "../crypto/index.js";
import type { Note } from "../notes/note.js";
import { dummyInputAt, toSpentNoteFromPath } from "./spent-note.js";

// A dummy slot's nullifier is public (`PubInputs.Transact.nullifier`). It is keyed by the spender's
// `nsk`, so neither `rho` nor `rcm` alone lets an observer recompute it.

let P: Poseidon;
beforeAll(async () => {
    P = await Poseidon.build();
});

describe("dummyInputAt", () => {
    const DEPTH = 4;
    const SECRETS = { nsk: 19n, rho: 7n, rcm: 5n };
    const dummy = (secrets = SECRETS) => dummyInputAt(P, DEPTH, secrets);

    it("is the zero-value note under the given nsk, rho and rcm", () => {
        const d = dummy();

        // The circuit derives the slot's pk from `nsk` and `in_d`; the SDK uses `in_d = 0`.
        expect(d).toMatchObject({
            asset: 0n,
            value: 0n,
            pk: derivePk(P, SECRETS.nsk, 0n),
            ...SECRETS,
        });
        expect(d.d).toBe(0n);
        expect(d.isDummy).toBe(true);
        expect(d.pathElements).toEqual(Array.from({ length: DEPTH }, () => [0n, 0n, 0n]));
        expect(d.pathIndices).toEqual([0, 0, 0, 0]);
        // Deterministic in the secrets.
        expect(dummy()).toEqual(d);
    });

    it("commits and nullifies the way the circuit recomputes them", () => {
        const { nsk, rho, rcm } = SECRETS;
        const d = dummy();

        // SpentNote: cm = Poseidon(TAG_CM, asset·2^64 + value, Poseidon(TAG_INNER, pk, rho, rcm)),
        // nf = Poseidon(TAG_NF, Poseidon(TAG_NK, nsk), rho, cm).
        const pk = derivePk(P, nsk, 0n);
        const cm = P.hash([TAG_CM, 0n, P.hash([TAG_INNER, pk, rho, rcm])]);
        expect(d.cm).toBe(cm);
        expect(d.nf).toBe(P.hash([TAG_NF, P.hash([TAG_NK, nsk]), rho, cm]));
    });

    it("keys the commitment and the nullifier by nsk", () => {
        const a = dummy();
        const b = dummy({ ...SECRETS, nsk: 23n });

        // The pk the note is committed under is derived from nsk, so both differ.
        expect(a.cm).not.toBe(b.cm);
        expect(a.nf).not.toBe(b.nf);
    });

    it("blinds the nullifier with rcm", () => {
        const a = dummy();
        const b = dummy({ ...SECRETS, rcm: 6n });

        expect(a.nf).not.toBe(b.nf);
    });

    it("gives every dummy a distinct nullifier", () => {
        const nsk = randomFr();
        const a = dummy({ nsk, rho: randomFr(), rcm: randomFr() });
        const b = dummy({ nsk, rho: randomFr(), rcm: randomFr() });

        expect(a.nf).not.toBe(b.nf);
    });
});

describe("toSpentNoteFromPath", () => {
    it("opens the leaf as the note commitment", () => {
        const note: Note = { asset: 7n, value: 100n, pk: 11n, rho: 13n, rcm: 17n };
        const path = [[1n, 2n, 3n]];

        const s = toSpentNoteFromPath(P, { note, nsk: 19n, d: 23n, leafIndex: 2 }, path, [2]);

        expect(s.cm).toBe(buildNoteCommitment(P, note));
        expect(s.nf).toBe(buildNullifierFromNsk(P, 19n, 13n, s.cm));
        expect(s).toMatchObject({ ...note, nsk: 19n, d: 23n, leafIndex: 2, isDummy: false });
        expect(s.pathElements).toBe(path);
        expect(s.pathIndices).toEqual([2]);
    });
});
