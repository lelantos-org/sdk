import { createCipheriv } from "node:crypto";
import { readFileSync } from "node:fs";
import { blake2b } from "@noble/hashes/blake2";
import { poseidon2 } from "poseidon-lite/poseidon2";
import { poseidon3 } from "poseidon-lite/poseidon3";
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
import { decodeAddress } from "./address.js";
import { deriveDefaultPk } from "./diversified.js";
import { defaultDiversifier } from "./diversifier.js";
import {
    addressFromSpendingKey,
    addressFromViewingKey,
    buildSpendingKey,
    fullViewingKeyFromSpending,
    viewingKeyFromSpending,
} from "./keys.js";

/**
 * `d0` from the definition, sharing no code with `keys/diversifier.ts`: blake2b-128 over the
 * domain and `LE32(ivk)` keys one raw AES-128 block over `LE4(0) || 0^12`, read little-endian.
 */
function d0FromDefinition(ivk: bigint): bigint {
    const ivkLe = new Uint8Array(32);
    for (let i = 0, v = ivk; i < 32; i++, v >>= 8n) ivkLe[i] = Number(v & 0xffn);
    const dvk = blake2b
        .create({ dkLen: 16 })
        .update(new TextEncoder().encode("lelantos.addr.dvk.v1"))
        .update(ivkLe)
        .digest();
    const cipher = createCipheriv("aes-128-ecb", dvk, null).setAutoPadding(false);
    const block = [...cipher.update(new Uint8Array(16)), ...cipher.final()];
    return block.reduceRight((acc, byte) => (acc << 8n) | BigInt(byte), 0n);
}

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
        expect(sk.pk).toBe(derivePk(P, 42n, defaultDiversifier(sk.ivk)));
        expect(sk.dk).toBe(deriveDk(P, sk.ivk));
        expect(sk.nk).toBe(deriveNk(P, 42n));
        expect(J.inSubgroup(sk.pk_d)).toBe(true);
    });

    it.each([1n, 42n, 0xdeadbeefn])("nsk %d: pk is Poseidon(TAG_PK, ivk, d0)", (nsk) => {
        const sk = buildSpendingKey(P, J, nsk);
        const ivk = poseidon2([4n, nsk]);
        const d0 = d0FromDefinition(ivk);

        expect(sk.ivk).toBe(ivk);
        expect(defaultDiversifier(ivk)).toBe(d0);
        expect(sk.pk).toBe(poseidon3([3n, ivk, d0]));
        // Not the arity-2 hash of `ivk` alone, nor the hash under a zero diversifier.
        expect(sk.pk).not.toBe(poseidon2([3n, ivk]));
        expect(sk.pk).not.toBe(poseidon3([3n, ivk, 0n]));
    });

    it("the address carries that pk, from a spending key and from a viewing key alone", () => {
        const sk = buildSpendingKey(P, J, 42n);
        const address = addressFromSpendingKey(J, sk);

        expect(decodeAddress(J, address).pk).toBe(sk.pk);
        expect(addressFromViewingKey(P, J, viewingKeyFromSpending(sk))).toBe(address);
    });

    // The default address is index 0 of the diversified scheme: its `pk` is the one
    // `tests/vectors/diversified.json` records for that index.
    it("pk is the diversified-address vector's at index 0", () => {
        const vectors = JSON.parse(
            readFileSync(new URL("../../tests/vectors/diversified.json", import.meta.url), "utf8"),
        ) as { addresses: { ivk_dec: string; index: number; d_dec: string; pk_dec: string }[] };
        const defaults = vectors.addresses.filter((a) => a.index === 0);

        expect(defaults.length).toBeGreaterThan(0);
        for (const a of defaults) {
            const ivk = BigInt(a.ivk_dec);
            expect(defaultDiversifier(ivk)).toBe(BigInt(a.d_dec));
            expect(deriveDefaultPk(P, ivk)).toBe(BigInt(a.pk_dec));
        }
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
