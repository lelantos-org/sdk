import { beforeAll, describe, expect, it } from "vitest";
import { BABYJUB_SUBGROUP_ORDER, Jubjub, Poseidon } from "./crypto/index.js";
import { buildSpendingKey } from "./keys.js";
import { decryptNote, encryptNote } from "./note-encrypt.js";

describe("note encryption", () => {
    let P: Poseidon;
    let J: Jubjub;
    beforeAll(async () => {
        P = await Poseidon.build();
        J = await Jubjub.build();
    });

    it("round-trip with correct ivk", () => {
        const sk = buildSpendingKey(P, J, 7777n);
        const pt = new TextEncoder().encode("hello, masp");
        const enc = encryptNote({
            J,
            recipientPkD: sk.pk_d,
            esk: 999n % BABYJUB_SUBGROUP_ORDER,
            plaintext: pt,
        });
        const out = decryptNote({ J, ivk: sk.ivk, note: enc });
        expect(out).not.toBeNull();
        expect(new TextDecoder().decode(out!)).toBe("hello, masp");
    });

    it("returns null for foreign ivk", () => {
        const sender = buildSpendingKey(P, J, 1n);
        const eve = buildSpendingKey(P, J, 2n);
        const pt = new Uint8Array([1, 2, 3, 4]);
        const enc = encryptNote({ J, recipientPkD: sender.pk_d, esk: 5n, plaintext: pt });
        expect(decryptNote({ J, ivk: eve.ivk, note: enc })).toBeNull();
    });
});
