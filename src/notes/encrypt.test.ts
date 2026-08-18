import { beforeAll, describe, expect, it } from "vitest";
import { BABYJUB_SUBGROUP_ORDER, Jubjub, Poseidon } from "../crypto/index.js";
import { buildSpendingKey } from "../keys/keys.js";
import { clueBitsToPrefix, packClueBits } from "./codec.js";
import { decryptNote, encryptNote } from "./encrypt.js";

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

describe("clue-bit packing", () => {
    // The wire prefix the indexer reads and the `out_clue_bits` witness slot
    // the proof commits to were two independent loops in two numeric types.
    // The contract recomputes the second from the first, so a drift in either
    // would make every proof fail verification with no local symptom.
    it("derives the wire prefix from the same packing as the witness slot", () => {
        const bits = new Uint8Array([0b10101]);
        const gamma = 5;

        const packed = packClueBits(bits, gamma);
        const prefix = clueBitsToPrefix(bits, gamma);

        expect(packed).toBe(0b10101n);
        expect((BigInt(prefix[0]!) << 8n) | BigInt(prefix[1]!)).toBe(packed);
    });

    it("refuses a gamma the 16-bit prefix cannot hold", () => {
        // The `number` version truncated silently past 16 and wrapped negative
        // at 31.
        expect(() => packClueBits(new Uint8Array(8), 17)).toThrow(/wire prefix/);
    });

    it("packs LSB-first across a byte boundary", () => {
        const bits = new Uint8Array([0x00, 0x01]); // bit 8 set
        expect(packClueBits(bits, 16)).toBe(1n << 8n);
    });
});
