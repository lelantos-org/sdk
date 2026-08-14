import { bech32m } from "bech32";
import { beforeAll, describe, expect, it } from "vitest";
import { FIELD_BYTES, toLeBytes } from "../crypto/bytes.js";
import { Jubjub, Poseidon } from "../crypto/index.js";
import { ADDRESS_HRP, decodeAddress, encodeAddress } from "./address.js";
import { addressFromSpendingKey, buildSpendingKey } from "./keys.js";

describe("bech32m address", () => {
    let P: Poseidon;
    let J: Jubjub;
    beforeAll(async () => {
        P = await Poseidon.build();
        J = await Jubjub.build();
    });

    it("round-trip carries pk_d, pk, ck", () => {
        const sk = buildSpendingKey(P, J, 0xdeadbeefn);
        const addr = encodeAddress(J, sk.pk_d, sk.pk, sk.ck);
        expect(addr.startsWith(`${ADDRESS_HRP}1`)).toBe(true);
        const dec = decodeAddress(J, addr);
        expect(dec.pk_d).toEqual(sk.pk_d);
        expect(dec.pk).toBe(sk.pk);
        expect(dec.ck).toEqual(sk.ck);
    });

    it("carries no detection material: dk is absent from the payload", () => {
        const sk = buildSpendingKey(P, J, 0xdeadbeefn);
        const payload = new Uint8Array(
            bech32m.fromWords(bech32m.decode(addressFromSpendingKey(J, sk), 256).words),
        );
        // The root detection secret must not appear in any 32-byte slot, in
        // either byte order.
        const dkLe = toLeBytes(sk.dk);
        const dkBe = Uint8Array.from(dkLe).reverse();
        for (let off = 0; off < payload.length; off += FIELD_BYTES) {
            const slot = payload.slice(off, off + FIELD_BYTES);
            expect(slot).not.toEqual(dkLe);
            expect(slot).not.toEqual(dkBe);
        }
    });

    it("addressFromSpendingKey matches manual encode", () => {
        const sk = buildSpendingKey(P, J, 42n);
        expect(addressFromSpendingKey(J, sk)).toBe(encodeAddress(J, sk.pk_d, sk.pk, sk.ck));
    });

    it("rejects bad HRP", () => {
        const sk = buildSpendingKey(P, J, 1n);
        const good = addressFromSpendingKey(J, sk);
        const bad = good.replace(new RegExp(`^${ADDRESS_HRP}`), "evil");
        expect(() => decodeAddress(J, bad)).toThrow();
    });

    it("rejects a payload with a field scalar in the `ck` slot", () => {
        // Same 96-byte length, so the length check passes and only the point
        // validation rejects it.
        const sk = buildSpendingKey(P, J, 7n);
        const payload = new Uint8Array(3 * FIELD_BYTES);
        payload.set(J.packPoint(sk.pk_d), 0);
        payload.set(toLeBytes(sk.dk), FIELD_BYTES);
        payload.set(toLeBytes(sk.pk), 2 * FIELD_BYTES);
        const addr = bech32m.encode(ADDRESS_HRP, bech32m.toWords(payload), 256);
        expect(() => decodeAddress(J, addr)).toThrow(/ck not/);
    });

    it("rejects a 64-byte payload", () => {
        const sk = buildSpendingKey(P, J, 7n);
        const payload = new Uint8Array(2 * FIELD_BYTES);
        payload.set(J.packPoint(sk.pk_d), 0);
        payload.set(toLeBytes(sk.dk), FIELD_BYTES);
        const short = bech32m.encode(ADDRESS_HRP, bech32m.toWords(payload), 256);
        expect(() => decodeAddress(J, short)).toThrow(/payload length/);
    });

    it("rejects an identity clue key", () => {
        // An identity `ck` expands to flag-key points with public discrete
        // logs, making every clue bit predictable. `unpackPoint` rejects it
        // first; the explicit identity check in `decodeAddress` is a backstop.
        const sk = buildSpendingKey(P, J, 9n);
        const payload = new Uint8Array(3 * FIELD_BYTES);
        payload.set(J.packPoint(sk.pk_d), 0);
        payload.set(toLeBytes(sk.pk), FIELD_BYTES);
        payload.set(J.packPoint([0n, 1n]), 2 * FIELD_BYTES);
        const addr = bech32m.encode(ADDRESS_HRP, bech32m.toWords(payload), 256);
        expect(() => decodeAddress(J, addr)).toThrow(/^ck (not|is)\b/);
    });
});
