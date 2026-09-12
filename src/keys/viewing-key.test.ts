import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { InvalidArgumentError } from "../core/errors.js";
import { BN254_FR } from "../core/field.js";
import { Jubjub, Poseidon } from "../crypto/index.js";
import {
    addressFromSpendingKey,
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
        sk = buildSpendingKey(P, J, 42n);
    });

    it("tags each tier with its own prefix", () => {
        expect(encodeViewingKey(viewingKeyFromSpending(sk)).startsWith(`${IVK_HRP}1`)).toBe(true);
        expect(encodeFullViewingKey(fullViewingKeyFromSpending(sk)).startsWith(`${FVK_HRP}1`)).toBe(
            true,
        );
    });

    it("round-trips either tier, for any nsk", () => {
        fc.assert(
            fc.property(nsk, (n) => {
                const key = buildSpendingKey(P, J, n);

                const vk = viewingKeyFromSpending(key);
                const backVk = decodeViewingKey(P, J, encodeViewingKey(vk));
                expect(backVk).toEqual(vk);
                expect(isFullViewingKey(backVk)).toBe(false);

                const fvk = fullViewingKeyFromSpending(key);
                const backFvk = decodeViewingKey(P, J, encodeFullViewingKey(fvk));
                expect(backFvk).toEqual(fvk);
                expect(isFullViewingKey(backFvk)).toBe(true);
            }),
            { numRuns: 30 },
        );
    });

    it("never encodes nsk, whatever the nsk", () => {
        fc.assert(
            fc.property(nsk, (n) => {
                const key = buildSpendingKey(P, J, n);
                for (const encoded of [
                    encodeViewingKey(viewingKeyFromSpending(key)),
                    encodeFullViewingKey(fullViewingKeyFromSpending(key)),
                ]) {
                    const back = decodeViewingKey(P, J, encoded);
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
                const key = buildSpendingKey(P, J, n);
                expect(addressFromViewingKey(P, J, viewingKeyFromSpending(key))).toBe(
                    addressFromSpendingKey(J, key),
                );
            }),
            { numRuns: 30 },
        );
    });

    it("rejects the wrong tier's prefix by length", () => {
        // An FVK payload under the IVK prefix: correct bytes, wrong prefix.
        const fvk = encodeFullViewingKey(fullViewingKeyFromSpending(sk));
        const swapped = `${IVK_HRP}${fvk.slice(FVK_HRP.length)}`;
        expect(() => decodeViewingKey(P, J, swapped)).toThrow(InvalidArgumentError);
    });

    it("rejects strings that are not viewing keys", () => {
        // Built in the body, not an `it.each` table: a table is evaluated at
        // collection time, before `beforeAll` builds `P` and `J`.
        for (const s of ["definitely-not-a-key", "", addressFromSpendingKey(J, sk)]) {
            expect(() => decodeViewingKey(P, J, s)).toThrow(InvalidArgumentError);
        }
    });

    it("keeps the key out of the error message", () => {
        const s = encodeViewingKey(viewingKeyFromSpending(sk));
        const tampered = `${s.slice(0, -4)}qqqq`;
        try {
            decodeViewingKey(P, J, tampered);
            expect.unreachable("should have thrown");
        } catch (err) {
            expect((err as Error).message).not.toContain(tampered.slice(IVK_HRP.length));
        }
    });
});
