import { beforeAll, describe, expect, it } from "vitest";
import {
    buildNullifier,
    buildNullifierFromNsk,
    deriveDk,
    deriveIvk,
    deriveNk,
    derivePk,
    Jubjub,
    Poseidon,
} from "../crypto/index.js";
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

describe("viewing-key capability tiers", () => {
    let P: Poseidon;
    let J: Jubjub;
    beforeAll(async () => {
        P = await Poseidon.build();
        J = await Jubjub.build();
    });

    // The tier split rests on `nk` deriving from `nsk` rather than `ivk`: an FVK
    // holder can settle which notes are spent, an IVK holder cannot.
    it("an FVK recomputes the same nullifier the spending key does", () => {
        const sk = buildSpendingKey(P, J, 7n);
        const fvk = fullViewingKeyFromSpending(sk);
        const rho = 11n;
        const cm = 13n;
        expect(buildNullifier(P, fvk.nk, rho, cm)).toBe(buildNullifierFromNsk(P, sk.nsk, rho, cm));
    });

    it("nk is not a function of ivk, so an IVK cannot reach it", () => {
        const a = buildSpendingKey(P, J, 7n);
        const b = buildSpendingKey(P, J, 8n);
        // A shared derivation input would collapse the two tiers.
        expect(a.nk).not.toBe(deriveNk(P, a.ivk));
        expect(a.nk).not.toBe(b.nk);
        // The incoming viewing key carries no field holding it.
        expect(Object.values(viewingKeyFromSpending(a))).not.toContain(a.nk);
    });
});
