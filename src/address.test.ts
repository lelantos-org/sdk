import { describe, it, expect, beforeAll } from "vitest";
import { Poseidon, Jubjub } from "./crypto/index";
import { addressFromSpendingKey, buildSpendingKey } from "./keys";
import { bech32m } from "bech32";
import { encodeAddress, decodeAddress, ADDRESS_HRP } from "./address";
import { FIELD_BYTES, toLeBytes } from "./crypto/bytes";

describe("bech32m address", () => {
    let P: Poseidon;
    let J: Jubjub;
    beforeAll(async () => {
        P = await Poseidon.build();
        J = await Jubjub.build();
    });

    it("round-trip carries pk_d, dk, pk", () => {
        const sk = buildSpendingKey(P, J, 0xdeadbeefn);
        const addr = encodeAddress(J, sk.pk_d, sk.dk, sk.pk);
        expect(addr.startsWith(ADDRESS_HRP + "1")).toBe(true);
        const dec = decodeAddress(J, addr);
        expect(dec.pk_d).toEqual(sk.pk_d);
        expect(dec.dk).toBe(sk.dk);
        expect(dec.pk).toBe(sk.pk);
    });

    it("addressFromSpendingKey matches manual encode", () => {
        const sk = buildSpendingKey(P, J, 42n);
        expect(addressFromSpendingKey(J, sk)).toBe(encodeAddress(J, sk.pk_d, sk.dk, sk.pk));
    });

    it("rejects bad HRP", () => {
        const sk = buildSpendingKey(P, J, 1n);
        const good = addressFromSpendingKey(J, sk);
        const bad = good.replace(new RegExp(`^${ADDRESS_HRP}`), "evil");
        expect(() => decodeAddress(J, bad)).toThrow();
    });

    it("rejects truncated payload (old 64-byte addresses)", () => {
        const sk = buildSpendingKey(P, J, 7n);
        const payload = new Uint8Array(2 * FIELD_BYTES);
        payload.set(J.packPoint(sk.pk_d), 0);
        payload.set(toLeBytes(sk.dk), FIELD_BYTES);
        const oldAddr = bech32m.encode(ADDRESS_HRP, bech32m.toWords(payload), 256);
        expect(() => decodeAddress(J, oldAddr)).toThrow(/payload length/);
    });
});
