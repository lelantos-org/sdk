import { beforeAll, describe, expect, it } from "vitest";
import { deriveDk, deriveIvk, deriveNk, derivePk, Jubjub, Poseidon } from "../crypto/index.js";
import { buildSpendingKey, fullViewingKeyFromSpending, viewingKeyFromSpending } from "./keys.js";

describe("key hierarchy", () => {
    let P: Poseidon;
    let J: Jubjub;
    beforeAll(async () => {
        P = await Poseidon.build();
        J = await Jubjub.build();
    });

    it("nsk → ivk → pk / dk / nk derive correctly", () => {
        const sk = buildSpendingKey(P, J, 42n);
        expect(sk.ivk).toBe(deriveIvk(P, 42n));
        expect(sk.pk).toBe(derivePk(P, 42n));
        expect(sk.dk).toBe(deriveDk(P, sk.ivk));
        expect(sk.nk).toBe(deriveNk(P, 42n));
        expect(J.inSubgroup(sk.pk_d)).toBe(true);
    });

    it("incoming viewing key has no nsk and no nk", () => {
        const sk = buildSpendingKey(P, J, 1n);
        const vk = viewingKeyFromSpending(sk);
        expect((vk as any).nsk).toBeUndefined();
        expect((vk as any).nk).toBeUndefined();
        expect(vk.ivk).toBe(sk.ivk);
    });

    it("full viewing key carries nk but not nsk", () => {
        const sk = buildSpendingKey(P, J, 1n);
        const fvk = fullViewingKeyFromSpending(sk);
        expect((fvk as any).nsk).toBeUndefined();
        expect(fvk.nk).toBe(sk.nk);
        expect(fvk.ivk).toBe(sk.ivk);
    });
});
