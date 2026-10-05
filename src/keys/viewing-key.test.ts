import { bech32m } from "bech32";
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { shieldedAddress } from "../core/brand.js";
import { FIELD_BYTES, toLeBytes } from "../core/bytes.js";
import { BABYJUB_SUBGROUP_ORDER, BN254_FR } from "../core/field.js";
import { Jubjub, Poseidon } from "../crypto/index.js";
import { InvalidArgumentError } from "../errors/config.js";
import { decodeAddress } from "./address.js";
import {
    addressFromViewingKey,
    buildSpendingKey,
    fullViewingKeyFromSpending,
    type SpendingKey,
    viewingKeyFromSpending,
} from "./keys.js";
import {
    decodeViewingKey,
    encodeFullViewingKey,
    encodeViewingKey,
    FVK_HRP,
    IVK_HRP,
    isFullViewingKey,
} from "./viewing-key.js";

/** A non-zero canonical field element, as every root key scalar must be. */
const nsk = fc.bigInt({ min: 1n, max: BN254_FR - 1n });

describe("viewing key codec", () => {
    let P: Poseidon;
    let J: Jubjub;
    let sk: SpendingKey;
    beforeAll(async () => {
        P = await Poseidon.build();
        J = await Jubjub.build();
        sk = buildSpendingKey(P, 42n);
    });

    it("tags each tier with its own prefix", () => {
        expect(encodeViewingKey(viewingKeyFromSpending(sk)).startsWith(`${IVK_HRP}1`)).toBe(true);
        expect(encodeFullViewingKey(fullViewingKeyFromSpending(sk)).startsWith(`${FVK_HRP}1`)).toBe(
            true,
        );
    });

    it("is never taken for a payment address", () => {
        for (const key of [
            encodeViewingKey(viewingKeyFromSpending(sk)),
            encodeFullViewingKey(fullViewingKeyFromSpending(sk)),
        ]) {
            expect(() => shieldedAddress(key)).toThrow(InvalidArgumentError);
            expect(() => decodeAddress(J, key)).toThrow(InvalidArgumentError);
        }
    });

    it("round-trips either tier, for any nsk", () => {
        fc.assert(
            fc.property(nsk, (n) => {
                const key = buildSpendingKey(P, n);

                const vk = viewingKeyFromSpending(key);
                const backVk = decodeViewingKey(P, encodeViewingKey(vk));
                expect(backVk).toEqual(vk);
                expect(isFullViewingKey(backVk)).toBe(false);

                const fvk = fullViewingKeyFromSpending(key);
                const backFvk = decodeViewingKey(P, encodeFullViewingKey(fvk));
                expect(backFvk).toEqual(fvk);
                expect(isFullViewingKey(backFvk)).toBe(true);
            }),
            { numRuns: 30 },
        );
    });

    it("never encodes nsk, whatever the nsk", () => {
        fc.assert(
            fc.property(nsk, (n) => {
                const key = buildSpendingKey(P, n);
                for (const encoded of [
                    encodeViewingKey(viewingKeyFromSpending(key)),
                    encodeFullViewingKey(fullViewingKeyFromSpending(key)),
                ]) {
                    const back = decodeViewingKey(P, encoded);
                    expect(Object.values(back)).not.toContain(key.nsk);
                    expect("nsk" in back).toBe(false);
                }
            }),
            { numRuns: 30 },
        );
    });

    it("resolves to the address of the account it views", () => {
        fc.assert(
            fc.property(nsk, (n) => {
                const key = buildSpendingKey(P, n);
                const decoded = decodeViewingKey(P, encodeViewingKey(viewingKeyFromSpending(key)));
                for (const index of [0, 3]) {
                    expect(addressFromViewingKey(P, J, decoded, index)).toBe(
                        addressFromViewingKey(P, J, key, index),
                    );
                }
            }),
            { numRuns: 30 },
        );
    });

    it("rejects the wrong tier's prefix by length", () => {
        // An FVK payload under the IVK prefix: correct bytes, wrong prefix.
        const fvk = encodeFullViewingKey(fullViewingKeyFromSpending(sk));
        const swapped = `${IVK_HRP}${fvk.slice(FVK_HRP.length)}`;
        expect(() => decodeViewingKey(P, swapped)).toThrow(InvalidArgumentError);
    });

    it("rejects strings that are not viewing keys", () => {
        // Not an `it.each` table: tables are evaluated at collection time, before `beforeAll`
        // builds `P` and `J`.
        for (const s of ["definitely-not-a-key", "", addressFromViewingKey(P, J, sk)]) {
            expect(() => decodeViewingKey(P, s)).toThrow(InvalidArgumentError);
        }
    });

    it("rejects an ivk that is zero mod the subgroup order", () => {
        // `q` is a canonical non-zero field element, and `q · g_d` is the identity for every `d`.
        for (const [hrp, scalars] of [
            [IVK_HRP, [BABYJUB_SUBGROUP_ORDER]],
            [FVK_HRP, [7n * BABYJUB_SUBGROUP_ORDER, 1n]],
        ] as const) {
            const payload = new Uint8Array(1 + scalars.length * FIELD_BYTES);
            payload[0] = 1;
            for (const [i, v] of scalars.entries()) payload.set(toLeBytes(v), 1 + i * FIELD_BYTES);
            const key = bech32m.encode(hrp, bech32m.toWords(payload), 256);
            expect(() => decodeViewingKey(P, key)).toThrow(/invalid viewing key: ivk is zero mod/);
        }
    });

    it("keeps the key out of the error message", () => {
        const s = encodeViewingKey(viewingKeyFromSpending(sk));
        const tampered = `${s.slice(0, -4)}qqqq`;
        try {
            decodeViewingKey(P, tampered);
            expect.unreachable("should have thrown");
        } catch (err) {
            expect((err as Error).message).not.toContain(tampered.slice(IVK_HRP.length));
        }
    });
});
