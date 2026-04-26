import { describe, it, expect, beforeAll } from "vitest";
import { Poseidon, Jubjub } from "./crypto/index";
import { buildSpendingKey } from "./keys";
import { encodeAddress, decodeAddress, ADDRESS_HRP } from "./address";

describe("bech32m address", () => {
    let P: Poseidon;
    let J: Jubjub;
    beforeAll(async () => {
        P = await Poseidon.build();
        J = await Jubjub.build();
    });

    it("round-trip", () => {
        const sk = buildSpendingKey(P, J, 0xdeadbeefn);
        const addr = encodeAddress(J, sk.pk_d, sk.dk);
        expect(addr.startsWith(ADDRESS_HRP + "1")).toBe(true);
        const dec = decodeAddress(J, addr);
        expect(dec.pk_d).toEqual(sk.pk_d);
        expect(dec.dk).toBe(sk.dk);
    });

    it("rejects bad HRP", () => {
        const sk = buildSpendingKey(P, J, 1n);
        const good = encodeAddress(J, sk.pk_d, sk.dk);
        const bad = good.replace(/^lelantos/, "evil");
        expect(() => decodeAddress(J, bad)).toThrow();
    });
});
