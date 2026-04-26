import { describe, it, expect, beforeAll } from "vitest";
import { Poseidon, Jubjub, deriveIvk, derivePk, deriveDk } from "./crypto/index";
import { buildSpendingKey, viewingKeyFromSpending } from "./keys";

describe("key hierarchy", () => {
    let P: Poseidon;
    let J: Jubjub;
    beforeAll(async () => {
        P = await Poseidon.build();
        J = await Jubjub.build();
    });

    it("nsk → ivk → pk / dk derive correctly", () => {
        const sk = buildSpendingKey(P, J, 42n);
        expect(sk.ivk).toBe(deriveIvk(P, 42n));
        expect(sk.pk).toBe(derivePk(P, 42n));
        expect(sk.dk).toBe(deriveDk(P, sk.ivk));
        expect(J.inSubgroup(sk.pk_d)).toBe(true);
    });

    it("viewing key has no nsk", () => {
        const sk = buildSpendingKey(P, J, 1n);
        const vk = viewingKeyFromSpending(sk);
        expect((vk as any).nsk).toBeUndefined();
        expect(vk.ivk).toBe(sk.ivk);
    });
});
