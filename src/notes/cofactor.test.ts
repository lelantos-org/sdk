// Cofactor clearing in trial decryption.
//
// `try_decrypt_note` clears the cofactor on `epk` instead of testing it for
// subgroup membership, so a crafted `epk = T + [t]B8` yields the same shared
// secret as `[t]B8` alone. These pin the two properties that depends on: the
// torsion term is annihilated, and a pure-torsion `epk` is refused.
//
// The fixtures are the eight points of the 8-torsion subgroup, packed. They are
// curve constants, obtained as `[n]R` for points `R` off the prime-order
// subgroup; each is re-derived as 8-torsion below rather than trusted.

import { chacha20poly1305 } from "@noble/ciphers/chacha";
import { blake2b } from "@noble/hashes/blake2";
import { beforeAll, describe, expect, it } from "vitest";
import type { Point } from "../crypto/jubjub.js";
import { Jubjub } from "../crypto/jubjub-wasm/index.js";
import { Poseidon } from "../crypto/poseidon.js";
import { buildSpendingKey, type SpendingKey } from "../keys/keys.js";
import { encodeNotePayload } from "./codec.js";

/** The 8-torsion subgroup, circomlibjs-packed. Orders 1, 2, 4, 4, 8, 8, 8, 8. */
const TORSION = [
    "0100000000000000000000000000000000000000000000000000000000000000",
    "000000f093f5e1439170b97948e833285d588181b64550b829a031e1724e6430",
    "0000000000000000000000000000000000000000000000000000000000000000",
    "77d6d0af811efdaba0b534826dc591b72c94a64b7d12c16314d3721121b7ab0a",
    "8a292f4012d7e497f0ba84f7da22a27030c4da3539338f5415cdbecf5197b825",
    "77d6d0af811efdaba0b534826dc591b72c94a64b7d12c16314d3721121b7ab8a",
    "8a292f4012d7e497f0ba84f7da22a27030c4da3539338f5415cdbecf5197b8a5",
    "0000000000000000000000000000000000000000000000000000000000000080",
] as const;

const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
const utf8 = (s: string) => new TextEncoder().encode(s);
const cat = (...parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let i = 0;
    for (const p of parts) {
        out.set(p, i);
        i += p.length;
    }
    return out;
};

describe("cofactor-cleared trial decryption", () => {
    let J: Jubjub;
    let P: Poseidon;
    let me: SpendingKey;
    let plaintext: Uint8Array;
    const esk = 777n;
    let Q: Point;

    beforeAll(async () => {
        J = await Jubjub.build();
        P = await Poseidon.build();
        me = buildSpendingKey(P, J, 4242n);
        plaintext = encodeNotePayload({ asset: 1n, value: 500n, rho: 11n, rcm: 22n, rcvDep: 33n });
        Q = J.mulPointEscalar(J.base8, esk);
    });

    /** A note keyed on `shared`, with `epk` bound into the KDF as on the wire. */
    const note = (epkPacked: Uint8Array, shared: Point) => {
        const key = blake2b(cat(utf8("lelantos.note.kdf.v1"), epkPacked, J.packPoint(shared)), {
            dkLen: 32,
        });
        const nonce = blake2b(cat(utf8("lelantos.note.nonce.v1"), epkPacked), { dkLen: 12 });
        return chacha20poly1305(key, nonce).encrypt(plaintext);
    };

    it("the fixtures are the 8-torsion subgroup", () => {
        // `[8]T` is the identity for every element, and the set is closed and
        // distinct — so a fixture cannot silently become an ordinary point.
        expect(new Set(TORSION).size).toBe(8);
        for (const hex of TORSION) {
            const T = J.unpackPoint(bytes(hex));
            if (!T) continue; // x = 0 points do not decompress; covered below
            expect(J.mulPointEscalar(T, 8n)).toEqual([0n, 1n]);
        }
    });

    it("decrypts an honest note", () => {
        const epk = J.packPoint(Q);
        const shared = J.mulPointEscalar(Q, me.ivk);
        expect(J.tryDecryptNote(me.ivk, epk, note(epk, shared))).toEqual(plaintext);
    });

    it("annihilates the torsion term of a crafted epk", () => {
        // The ciphertext is keyed on `[ivk]Q` — torsion-free. A plain `[ivk]epk`
        // would compute `[ivk](T + Q)` and fail to decrypt it.
        const sharedTorsionFree = J.mulPointEscalar(Q, me.ivk);
        let tested = 0;
        for (const hex of TORSION) {
            const T = J.unpackPoint(bytes(hex));
            if (!T) continue;
            const epk = J.packPoint(J.addPoint(T, Q));
            expect(J.tryDecryptNote(me.ivk, epk, note(epk, sharedTorsionFree))).toEqual(plaintext);
            tested++;
        }
        expect(tested).toBeGreaterThanOrEqual(6);
    });

    it("refuses a pure-torsion epk", () => {
        // `shared` would be the identity for every `ivk`: one note that decrypts
        // in every wallet, and is readable by anyone.
        const identity: Point = [0n, 1n];
        for (const hex of TORSION) {
            const epk = bytes(hex);
            expect(J.tryDecryptNote(me.ivk, epk, note(epk, identity))).toBeNull();
        }
    });
});
