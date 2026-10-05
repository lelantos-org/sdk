import { createCipheriv } from "node:crypto";
import { readFileSync } from "node:fs";
import { blake2b } from "@noble/hashes/blake2";
import { poseidon2 } from "poseidon-lite/poseidon2";
import { poseidon3 } from "poseidon-lite/poseidon3";
import { beforeAll, describe, expect, it } from "vitest";
import { BABYJUB_SUBGROUP_ORDER } from "../core/field.js";
import { diversifiedBase } from "../crypto/diversified-base.js";
import {
    buildNullifier,
    buildNullifierFromNsk,
    deriveDk,
    deriveIvk,
    deriveNk,
    Jubjub,
    Poseidon,
} from "../crypto/index.js";
import { fmdFlagOnBase, fmdTest } from "../fmd/clue.js";
import { fmdDiversifiedDetectionKey, fmdDiversifiedFlagKey } from "../fmd/diversified.js";
import { FMD_DEFAULT_GAMMA } from "../fmd/keys.js";
import { decodeAddress } from "./address.js";
import { deriveDkRoot, ownsAddress } from "./diversified.js";
import { defaultDiversifier } from "./diversifier.js";
import {
    addressFromViewingKey,
    buildFullViewingKey,
    buildSpendingKey,
    buildViewingKey,
    deriveKeysFromNsk,
    detectionKeyFor,
    fullViewingKeyFromSpending,
    type SpendingKey,
    viewingKeyFromSpending,
} from "./keys.js";

const q = BABYJUB_SUBGROUP_ORDER;

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

let P: Poseidon;
let J: Jubjub;
/** The spending key of nsk 42. */
let sk: SpendingKey;
beforeAll(async () => {
    P = await Poseidon.build();
    J = await Jubjub.build();
    sk = buildSpendingKey(P, 42n);
});

describe("key hierarchy", () => {
    it("nsk → ivk → dk / nk derive correctly", () => {
        expect(sk.nsk).toBe(42n);
        expect(sk.ivk).toBe(deriveIvk(P, 42n));
        expect(sk.dk).toBe(deriveDk(P, sk.ivk));
        expect(sk.nk).toBe(deriveNk(P, 42n));
    });

    it("the key structs hold scalars only", () => {
        expect(Object.keys(sk).sort()).toEqual(["dk", "ivk", "nk", "nsk"]);
        expect(Object.keys(buildViewingKey(P, sk.ivk)).sort()).toEqual(["dk", "ivk"]);
        expect(Object.keys(buildFullViewingKey(P, sk.ivk, sk.nk)).sort()).toEqual([
            "dk",
            "ivk",
            "nk",
        ]);
        expect(buildFullViewingKey(P, sk.ivk, sk.nk)).toEqual(fullViewingKeyFromSpending(sk));
    });

    it("rejects an ivk that is zero mod q", () => {
        for (const degenerate of [0n, q, 7n * q]) {
            expect(() => buildViewingKey(P, degenerate)).toThrow(/ivk must be non-zero mod q/);
            expect(() => buildFullViewingKey(P, degenerate, 1n)).toThrow(
                /ivk must be non-zero mod q/,
            );
        }
    });

    it("rejects a dk that is zero mod q", () => {
        // No known ivk hashes to a multiple of q, so the hash is stubbed.
        for (const digest of [0n, q]) {
            const stub = { backend: "js", hash: () => digest } satisfies Poseidon;
            expect(() => buildViewingKey(stub, 5n)).toThrow(/dk must be non-zero mod q/);
        }
    });

    it.each([
        1n,
        42n,
        0xdeadbeefn,
    ])("nsk %d: the default address carries d0 and pk = Poseidon(TAG_PK, ivk, d0)", (nsk) => {
        const sk = buildSpendingKey(P, nsk);
        const ivk = poseidon2([4n, nsk]);
        const d0 = d0FromDefinition(ivk);
        const { d, pk } = decodeAddress(J, addressFromViewingKey(P, J, sk));

        expect(sk.ivk).toBe(ivk);
        expect(defaultDiversifier(ivk)).toBe(d0);
        expect(d).toBe(d0);
        expect(pk).toBe(poseidon3([3n, ivk, d0]));
        // Not the arity-2 hash of `ivk` alone, nor the hash under a zero diversifier.
        expect(pk).not.toBe(poseidon2([3n, ivk]));
        expect(pk).not.toBe(poseidon3([3n, ivk, 0n]));
    });

    it("a spending key, its viewing key and deriveKeysFromNsk agree on the default address", async () => {
        const address = addressFromViewingKey(P, J, sk);

        expect(addressFromViewingKey(P, J, viewingKeyFromSpending(sk))).toBe(address);
        expect(addressFromViewingKey(P, J, sk, 0)).toBe(address);
        const derived = await deriveKeysFromNsk(42n, { P, J });
        expect(derived.address).toBe(address);
        expect(derived.keys).toEqual(sk);
    });

    it("every index gives a distinct address the viewing key owns", () => {
        const other = buildSpendingKey(P, 43n);
        const indices = [0, 1, 2, 77, 2 ** 32 - 1];
        const addresses = indices.map((index) => addressFromViewingKey(P, J, sk, index));

        expect(new Set(addresses).size).toBe(indices.length);
        for (const address of addresses) {
            const decoded = decodeAddress(J, address);
            expect(ownsAddress(P, J, sk.ivk, decoded)).toBe(true);
            expect(ownsAddress(P, J, other.ivk, decoded)).toBe(false);
        }
    });

    it("rejects an index outside [0, 2^32)", () => {
        for (const index of [-1, 2 ** 32, 1.5, Number.NaN]) {
            expect(() => addressFromViewingKey(P, J, sk, index)).toThrow(/diversifier index/);
        }
    });

    // `tests/vectors/diversified.json` records `d` and `pk` per `(ivk, index)`.
    it("addresses carry the diversified-address vectors' d and pk", () => {
        const vectors = JSON.parse(
            readFileSync(new URL("../../tests/vectors/diversified.json", import.meta.url), "utf8"),
        ) as { addresses: { ivk_dec: string; index: number; d_dec: string; pk_dec: string }[] };

        expect(vectors.addresses.some((a) => a.index === 0)).toBe(true);
        expect(vectors.addresses.some((a) => a.index !== 0)).toBe(true);
        for (const a of vectors.addresses) {
            const vk = buildViewingKey(P, BigInt(a.ivk_dec));
            const decoded = decodeAddress(J, addressFromViewingKey(P, J, vk, a.index));
            expect(decoded.d).toBe(BigInt(a.d_dec));
            expect(decoded.pk).toBe(BigInt(a.pk_dec));
        }
    });

    it("incoming viewing key has no nsk and no nk", () => {
        const sk = buildSpendingKey(P, 1n);
        const vk = viewingKeyFromSpending(sk);
        expect((vk as any).nsk).toBeUndefined();
        expect((vk as any).nk).toBeUndefined();
        expect(vk).toEqual({ ivk: sk.ivk, dk: sk.dk });
    });

    it("full viewing key carries nk but not nsk", () => {
        const sk = buildSpendingKey(P, 1n);
        const fvk = fullViewingKeyFromSpending(sk);
        expect((fvk as any).nsk).toBeUndefined();
        expect(fvk.nk).toBe(sk.nk);
        expect(fvk.ivk).toBe(sk.ivk);
    });
});

describe("detection key", () => {
    /** A clue as a sender builds it, from the address string alone. */
    const flag = (address: string, r: bigint) => {
        const { d, ck_d } = decodeAddress(J, address);
        const g_d = diversifiedBase(J, P, d);
        return fmdFlagOnBase(J, P, fmdDiversifiedFlagKey(J, P, ck_d, g_d), g_d, r);
    };

    it("is the diversified expansion of dk, at the default gamma", () => {
        const vk = viewingKeyFromSpending(sk);
        const dk = detectionKeyFor(P, vk);
        expect(dk.x).toHaveLength(FMD_DEFAULT_GAMMA);
        expect(dk).toEqual(fmdDiversifiedDetectionKey(P, deriveDkRoot(P, vk.ivk)));
        expect(detectionKeyFor(P, vk, 3)).toEqual({ x: dk.x.slice(0, 3) });
    });

    it("one detection key detects clues for two indices of the account", () => {
        const dk = detectionKeyFor(P, viewingKeyFromSpending(sk));
        for (const index of [0, 5]) {
            const address = addressFromViewingKey(P, J, sk, index);
            for (let r = 1n; r <= 8n; r++) expect(fmdTest(J, P, dk, flag(address, r))).toBe(true);
        }
    });

    it("does not detect another account's clues beyond the false-positive rate", () => {
        const dk = detectionKeyFor(P, sk);
        const stranger = addressFromViewingKey(P, J, buildSpendingKey(P, 43n), 5);
        let accepted = 0;
        for (let r = 1n; r <= 64n; r++) if (fmdTest(J, P, dk, flag(stranger, r))) accepted++;
        // Expected 64 / 32 = 2; the inputs are fixed, so the count is too.
        expect(accepted).toBeLessThan(16);
    });

    it("rejects a gamma above the sender gamma", () => {
        const vk = viewingKeyFromSpending(sk);
        expect(() => detectionKeyFor(P, vk, FMD_DEFAULT_GAMMA + 1)).toThrow(/exceeds the sender/);
        expect(() => detectionKeyFor(P, vk, 0)).toThrow(/positive integer/);
    });
});

describe("viewing-key capability tiers", () => {
    // The tier split rests on `nk` deriving from `nsk` rather than `ivk`: an FVK
    // holder can settle which notes are spent, an IVK holder cannot.
    it("an FVK recomputes the same nullifier the spending key does", () => {
        const sk = buildSpendingKey(P, 7n);
        const fvk = fullViewingKeyFromSpending(sk);
        const rho = 11n;
        const cm = 13n;
        expect(buildNullifier(P, fvk.nk, rho, cm)).toBe(buildNullifierFromNsk(P, sk.nsk, rho, cm));
    });

    it("nk is not a function of ivk, so an IVK cannot reach it", () => {
        const a = buildSpendingKey(P, 7n);
        const b = buildSpendingKey(P, 8n);
        // A shared derivation input would collapse the two tiers.
        expect(a.nk).not.toBe(deriveNk(P, a.ivk));
        expect(a.nk).not.toBe(b.nk);
        // The incoming viewing key carries no field holding it.
        expect(Object.values(viewingKeyFromSpending(a))).not.toContain(a.nk);
    });
});
