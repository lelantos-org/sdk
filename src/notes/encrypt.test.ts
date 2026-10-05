import { beforeAll, describe, expect, it } from "vitest";
import {
    BABYJUB_SUBGROUP_ORDER,
    deriveIvk,
    type Field,
    Jubjub,
    Poseidon,
} from "../crypto/index.js";
import { buildDiversifiedKeys, type DiversifiedKeys } from "../keys/diversified.js";
import { diversifierForIndex } from "../keys/diversifier.js";
import { clueBitsToPrefix, packClueBits } from "./codec.js";
import { decryptNote, encryptNote, openNoteAsSender } from "./encrypt.js";
import type { EncryptedNote } from "./note.js";

let P: Poseidon;
let J: Jubjub;
beforeAll(async () => {
    P = await Poseidon.build();
    J = await Jubjub.build();
});

/** The viewing key of `nsk` and its address at diversifier `index`. */
function addressOf(nsk: Field, index = 0): DiversifiedKeys & { ivk: Field } {
    const ivk = deriveIvk(P, nsk);
    const d = diversifierForIndex(ivk, index);
    return { ivk, ...buildDiversifiedKeys(P, J, ivk, d) };
}

/** `plaintext` encrypted to `to` on its own base. */
function encryptTo(to: DiversifiedKeys, esk: Field, plaintext: Uint8Array): EncryptedNote {
    return encryptNote({ J, gD: to.g_d, recipientPkD: to.pk_d, esk, plaintext });
}

describe("note encryption", () => {
    const ESK = 999n;

    it("round-trip with correct ivk", () => {
        const to = addressOf(7777n);
        const pt = new TextEncoder().encode("hello, masp");
        const enc = encryptTo(to, ESK, pt);
        const out = decryptNote({ J, ivk: to.ivk, note: enc });
        expect(out).not.toBeNull();
        expect(new TextDecoder().decode(out!)).toBe("hello, masp");
    });

    it("publishes the ephemeral key on the address base", () => {
        const to = addressOf(7777n, 3);
        const enc = encryptTo(to, ESK, new Uint8Array(4));

        expect(enc.epk).toEqual(J.packPoint(J.mulPointEscalar(to.g_d, ESK)));
        expect(enc.epk).not.toEqual(J.packPoint(J.mulPointEscalar(J.base8, ESK)));
    });

    it("opens notes to every address of one ivk", () => {
        const pt = new Uint8Array([9, 8, 7]);
        for (const index of [0, 1, 2 ** 32 - 1]) {
            const to = addressOf(7777n, index);
            const enc = encryptTo(to, ESK, pt);
            expect(decryptNote({ J, ivk: to.ivk, note: enc })).toEqual(pt);
        }
    });

    it("does not open a note whose ephemeral key is on another base", () => {
        // `ivk · epk` equals `esk · pk_d` only when `epk` is a multiple of the address's `g_d`.
        const to = addressOf(7777n);
        const other = addressOf(7777n, 1);
        for (const gD of [J.base8, other.g_d]) {
            const enc = encryptNote({
                J,
                gD,
                recipientPkD: to.pk_d,
                esk: ESK,
                plaintext: new Uint8Array(4),
            });
            expect(decryptNote({ J, ivk: to.ivk, note: enc })).toBeNull();
        }
    });

    it("returns null for foreign ivk", () => {
        const to = addressOf(1n);
        const eve = addressOf(2n);
        const pt = new Uint8Array([1, 2, 3, 4]);
        const enc = encryptTo(to, 5n, pt);
        expect(decryptNote({ J, ivk: eve.ivk, note: enc })).toBeNull();
    });

    it("refuses a zero ephemeral secret", () => {
        const to = addressOf(1n);
        for (const esk of [0n, BABYJUB_SUBGROUP_ORDER]) {
            expect(() => encryptTo(to, esk, new Uint8Array(4))).toThrow(/esk/);
        }
    });
});

// The sender's side of the same ciphertext: opened with the ephemeral secret
// and the payee's public key, which is what a payment proof hands a verifier.
describe("opening a note as its sender", () => {
    const PLAINTEXT = new Uint8Array([1, 2, 3, 4, 5]);
    const ESK = 123456789n;

    const noteTo = (to: DiversifiedKeys) => encryptTo(to, ESK, PLAINTEXT);

    it("opens what the recipient's ivk opens", () => {
        const payee = addressOf(11n, 2);
        const note = noteTo(payee);

        expect(openNoteAsSender({ J, recipientPkD: payee.pk_d, esk: ESK, note })).toEqual(
            PLAINTEXT,
        );
        expect(decryptNote({ J, ivk: payee.ivk, note })).toEqual(PLAINTEXT);
    });

    it("is null for a secret that is not the note's ephemeral", () => {
        const payee = addressOf(11n);
        const note = noteTo(payee);

        expect(openNoteAsSender({ J, recipientPkD: payee.pk_d, esk: ESK + 1n, note })).toBeNull();
        expect(openNoteAsSender({ J, recipientPkD: payee.pk_d, esk: 0n, note })).toBeNull();
    });

    it("is null for an address the note was not encrypted to", () => {
        const payee = addressOf(11n);
        const note = noteTo(payee);

        // Another account, and another address of the payee's own account.
        for (const other of [addressOf(12n), addressOf(11n, 1)]) {
            expect(openNoteAsSender({ J, recipientPkD: other.pk_d, esk: ESK, note })).toBeNull();
        }
    });
});

describe("clue-bit packing", () => {
    // The wire prefix and the `out_clue_bits` witness slot must share one packing: the contract
    // recomputes the second from the first.
    it("derives the wire prefix from the same packing as the witness slot", () => {
        const bits = new Uint8Array([0b10101]);
        const gamma = 5;

        const packed = packClueBits(bits, gamma);
        const prefix = clueBitsToPrefix(bits, gamma);

        expect(packed).toBe(0b10101n);
        expect((BigInt(prefix[0]!) << 8n) | BigInt(prefix[1]!)).toBe(packed);
    });

    it("refuses a gamma the 16-bit prefix cannot hold", () => {
        expect(() => packClueBits(new Uint8Array(8), 17)).toThrow(/wire prefix/);
    });

    it("packs LSB-first across a byte boundary", () => {
        const bits = new Uint8Array([0x00, 0x01]); // bit 8 set
        expect(packClueBits(bits, 16)).toBe(1n << 8n);
    });
});
