import { beforeAll, describe, expect, it } from "vitest";
import { BABYJUB_SUBGROUP_ORDER } from "../core/field.js";
import { deriveDk, deriveIvk, derivePkFromIvk } from "../crypto/derive.js";
import { DIVERSIFIER_BOUND, diversifiedBase } from "../crypto/diversified-base.js";
import type { Point } from "../crypto/jubjub.js";
import { Jubjub } from "../crypto/jubjub-wasm/index.js";
import { Poseidon } from "../crypto/poseidon.js";
import {
    buildDiversifiedKeys,
    deriveDiversifiedPk,
    deriveDkRoot,
    ownsAddress,
} from "./diversified.js";
import { diversifierForIndex } from "./diversifier.js";

const q = BABYJUB_SUBGROUP_ORDER;
const isIdentity = (p: Point) => p[0] === 0n && p[1] === 1n;

describe("diversified keys", () => {
    let J: Jubjub;
    let P: Poseidon;
    let ivk: bigint;
    let ds: bigint[];
    beforeAll(async () => {
        J = await Jubjub.build();
        P = await Poseidon.build();
        ivk = deriveIvk(P, 42n);
        ds = [0, 1, 2, 2 ** 32 - 1].map((index) => diversifierForIndex(ivk, index));
    });

    it("pk is Poseidon(3, ivk, d) and differs across d", () => {
        const pks = ds.map((d) => deriveDiversifiedPk(P, ivk, d));
        for (const [i, d] of ds.entries()) expect(pks[i]).toBe(P.hash([3n, ivk, d]));
        expect(new Set(pks).size).toBe(ds.length);
        // Arity separates it from the arity-2 hash of `ivk` alone even at d = 0.
        expect(deriveDiversifiedPk(P, ivk, 0n)).not.toBe(P.hash([3n, ivk]));
        expect(deriveDiversifiedPk(P, ivk, ds[1]!)).toBe(derivePkFromIvk(P, ivk, ds[1]!));
    });

    it("pk_d and ck_d are non-identity subgroup points on g_d", () => {
        const dkRoot = deriveDk(P, ivk) % q;
        for (const d of ds) {
            const keys = buildDiversifiedKeys(P, J, ivk, d);
            expect(keys.d).toBe(d);
            expect(keys.g_d).toEqual(diversifiedBase(J, P, d));
            expect(keys.pk).toBe(deriveDiversifiedPk(P, ivk, d));
            expect(keys.pk_d).toEqual(J.mulPointEscalar(keys.g_d, ivk % q));
            expect(keys.ck_d).toEqual(J.mulPointEscalar(keys.g_d, dkRoot));
            for (const point of [keys.pk_d, keys.ck_d]) {
                expect(J.inSubgroup(point)).toBe(true);
                expect(isIdentity(point)).toBe(false);
            }
            expect(keys.pk_d).not.toEqual(keys.ck_d);
        }
    });

    it("gives every address its own base and keys", () => {
        const keys = ds.map((d) => buildDiversifiedKeys(P, J, ivk, d));
        const pack = (p: Point) => p.join(",");
        for (const field of ["g_d", "pk_d", "ck_d"] as const) {
            expect(new Set(keys.map((k) => pack(k[field]))).size).toBe(ds.length);
        }
    });

    it("ECDH on g_d agrees between sender and recipient", () => {
        const esk = 0x1234_5678_9abc_def0n;
        for (const d of ds) {
            const { g_d, pk_d } = buildDiversifiedKeys(P, J, ivk, d);
            const epk = J.mulPointEscalar(g_d, esk);
            expect(J.mulPointEscalar(pk_d, esk)).toEqual(J.mulPointEscalar(epk, ivk % q));
        }
    });

    it("dk_root is Poseidon(6, ivk) mod q and does not depend on d", () => {
        expect(deriveDkRoot(P, ivk)).toBe(P.hash([6n, ivk]) % q);
        expect(deriveDkRoot(P, ivk)).toBeLessThan(q);
    });

    it("rejects an ivk that is zero mod q", () => {
        for (const degenerate of [0n, q, 7n * q]) {
            expect(() => buildDiversifiedKeys(P, J, degenerate, ds[0]!)).toThrow(
                /ivk must be non-zero mod q/,
            );
        }
    });

    it("rejects a dk_root that is zero mod q", () => {
        // No known ivk hashes to a multiple of q, so the hash is stubbed.
        for (const digest of [0n, q]) {
            const stub = { backend: "js", hash: () => digest } satisfies Poseidon;
            expect(() => deriveDkRoot(stub, ivk)).toThrow(/dk_root must be non-zero mod q/);
            expect(() => buildDiversifiedKeys(stub, J, ivk, ds[0]!)).toThrow(
                /dk_root must be non-zero mod q/,
            );
        }
    });

    it("owns exactly the addresses it derives", () => {
        const stranger = deriveIvk(P, 43n);
        for (const d of ds) {
            const own = buildDiversifiedKeys(P, J, ivk, d);
            expect(ownsAddress(P, J, ivk, own)).toBe(true);
            expect(ownsAddress(P, J, stranger, own)).toBe(false);
        }
        // A diversifier the account never issued still names one of its addresses.
        expect(ownsAddress(P, J, ivk, buildDiversifiedKeys(P, J, ivk, 0n))).toBe(true);
    });

    it("does not own an address with any one field from elsewhere", () => {
        const own = buildDiversifiedKeys(P, J, ivk, ds[0]!);
        const sibling = buildDiversifiedKeys(P, J, ivk, ds[1]!);
        const foreign = buildDiversifiedKeys(P, J, deriveIvk(P, 43n), ds[0]!);
        for (const from of [sibling, foreign]) {
            for (const field of ["pk", "pk_d", "ck_d"] as const) {
                expect(ownsAddress(P, J, ivk, { ...own, [field]: from[field] })).toBe(false);
            }
        }
        expect(ownsAddress(P, J, ivk, { ...own, d: sibling.d })).toBe(false);
    });

    it("owns no address whose d is not a 16-byte diversifier", () => {
        const own = buildDiversifiedKeys(P, J, ivk, ds[0]!);
        expect(ownsAddress(P, J, ivk, { ...own, d: DIVERSIFIER_BOUND })).toBe(false);
        expect(ownsAddress(P, J, ivk, { ...own, d: -1n })).toBe(false);
    });

    it("rejects a d that is not a 16-byte diversifier", () => {
        expect(() => deriveDiversifiedPk(P, ivk, DIVERSIFIER_BOUND)).toThrow(/16-byte diversifier/);
        expect(() => buildDiversifiedKeys(P, J, ivk, DIVERSIFIER_BOUND)).toThrow(
            /16-byte diversifier/,
        );
    });
});
