// The per-output aux payload: the clue's subgroup witness, and the base every published point of
// an output is a multiple of.
//
// The pool accepts a clue `R` only with a point `Q` it can double three times
// onto `R`. `clueSubgroupWitness` derives `Q = [8^-1]R`.

import { beforeAll, describe, expect, it } from "vitest";
import { BABYJUB_INV8, BABYJUB_SUBGROUP_ORDER } from "../core/field.js";
import { deriveIvk } from "../crypto/derive.js";
import type { Point } from "../crypto/jubjub.js";
import { Jubjub } from "../crypto/jubjub-wasm/index.js";
import { Poseidon } from "../crypto/poseidon.js";
import { fmdTest } from "../fmd/clue.js";
import { fmdDiversifiedDetectionKey, fmdDiversifiedFlagKey } from "../fmd/diversified.js";
import { buildDiversifiedKeys, deriveDkRoot } from "../keys/diversified.js";
import { diversifierForIndex } from "../keys/diversifier.js";
import { clueOf } from "../test-utils/outputs.js";
import { buildOutputAux, clueSubgroupWitness } from "./aux.js";
import {
    CLUE_BITS_PREFIX_BYTES,
    decodeNotePayload,
    encodeMemo,
    NOTE_PLAINTEXT_BYTES,
    type NotePayload,
    stripClueBitsPrefix,
} from "./codec.js";
import { decryptNote } from "./encrypt.js";
import { expandSeed } from "./seed.js";

let J: Jubjub;
let P: Poseidon;

beforeAll(async () => {
    J = await Jubjub.build();
    P = await Poseidon.build();
});

/** `[8]p` by doubling, as `BabyJubJub.isEightfold` computes it. */
const times8 = (p: Point): Point => {
    let acc = p;
    for (let i = 0; i < 3; i++) acc = J.addPoint(acc, acc);
    return acc;
};

describe("clueSubgroupWitness", () => {
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

describe("buildOutputAux", () => {
    const ivk = () => deriveIvk(P, 4242n);

    /** An output to the address at `index`, with the randomness its seed expands to. */
    function output(index: number) {
        const d = diversifierForIndex(ivk(), index);
        const to = buildDiversifiedKeys(P, J, ivk(), d);
        const note: NotePayload = {
            asset: 1n,
            value: 500n,
            rho: 12345n,
            rseed: new Uint8Array(32).fill(index + 1),
            d,
            memo: encodeMemo(`memo ${index}`),
        };
        const seed = expandSeed(note.rseed, note.rho);
        const built = buildOutputAux({
            J,
            P,
            recipientFlagKey: fmdDiversifiedFlagKey(J, P, to.ck_d, to.g_d),
            recipientPkD: to.pk_d,
            gD: to.g_d,
            note,
            esk: seed.esk,
            fmdR: seed.fmdR,
        });
        return { to, note, seed, ...built };
    }

    it("publishes the ephemeral key and the clue point on the address base", () => {
        for (const index of [0, 5]) {
            const { to, seed, aux } = output(index);

            expect(aux.ephPub).toEqual(J.mulPointEscalar(to.g_d, seed.esk));
            expect(aux.clueR).toEqual(J.mulPointEscalar(to.g_d, seed.fmdR));
            expect(times8(aux.clueQ)).toEqual(aux.clueR);
        }
    });

    it("is detected by the account's one detection key at any address", () => {
        const dk = fmdDiversifiedDetectionKey(P, deriveDkRoot(P, ivk()));
        for (const index of [0, 5]) {
            const { aux, witness } = output(index);
            const { prefix } = stripClueBitsPrefix(aux.ciphertext);

            // γ = 5 bits fit in the low byte of the big-endian prefix.
            expect(prefix[0]).toBe(0);
            expect(witness.clueBits).toBe(BigInt(prefix[1]!));
            expect(witness).toMatchObject({ clueRx: aux.clueR[0], clueRy: aux.clueR[1] });
            expect(fmdTest(J, P, dk, clueOf(J, aux))).toBe(true);
        }
    });

    it("carries the 224-byte plaintext, opened by the recipient's ivk", () => {
        const { note, aux } = output(5);
        const { body } = stripClueBitsPrefix(aux.ciphertext);
        const plain = decryptNote({
            J,
            ivk: ivk(),
            note: { epk: J.packPoint(aux.ephPub), ciphertext: body },
        });

        // Prefix, plaintext and the 16-byte Poly1305 tag.
        expect(aux.ciphertext).toHaveLength(CLUE_BITS_PREFIX_BYTES + NOTE_PLAINTEXT_BYTES + 16);
        expect(aux.ciphertext).toHaveLength(242);
        expect(plain && decodeNotePayload(plain)).toEqual(note);
    });
});
