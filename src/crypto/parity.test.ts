// Parity tests. Pin SDK primitives byte-for-byte against the values they
// MUST produce. If circuits change the tag scheme, these tests fail.

import { describe, it, expect, beforeAll } from "vitest";
import {
    Poseidon,
    Jubjub,
    H_BASE,
    deriveIvk,
    derivePk,
    derivePkFromIvk,
    deriveDk,
    buildNoteCommitment,
    buildNullifier,
    MerkleTree,
    TAG_NF,
    TAG_PK,
    TAG_IVK,
    TAG_MERKLE,
    TAG_DK,
    TAG_ASSET,
    POW_2_64,
} from "./index";

describe("crypto parity with circuits/src/lib", () => {
    let P: Poseidon;
    let J: Jubjub;

    beforeAll(async () => {
        P = await Poseidon.build();
        J = await Jubjub.build();
    });

    it("tag values match tags.circom", () => {
        expect(TAG_NF).toBe(2n);
        expect(TAG_PK).toBe(3n);
        expect(TAG_IVK).toBe(4n);
        expect(TAG_MERKLE).toBe(5n);
        expect(TAG_DK).toBe(6n);
        expect(TAG_ASSET).toBe(7n);
    });

    it("ivk = Poseidon(4, nsk); pk = Poseidon(3, ivk)", () => {
        const nsk = 12345n;
        const ivk = deriveIvk(P, nsk);
        const pk = derivePk(P, nsk);
        expect(ivk).toBe(P.hash([4n, nsk]));
        expect(pk).toBe(P.hash([3n, ivk]));
        expect(derivePkFromIvk(P, ivk)).toBe(pk);
    });

    it("dk = Poseidon(6, ivk)", () => {
        const ivk = 999n;
        expect(deriveDk(P, ivk)).toBe(P.hash([6n, ivk]));
    });

    it("nf = Poseidon(2, nsk, rho)", () => {
        const nsk = 7n, rho = 11n;
        expect(buildNullifier(P, nsk, rho)).toBe(P.hash([2n, nsk, rho]));
    });

    it("cm = Poseidon(asset*2^64+value, pk, rho, rcm)", () => {
        const n = { asset: 3n, value: 100n, pk: 42n, rho: 9n, rcm: 17n };
        const expected = P.hash([n.asset * POW_2_64 + n.value, n.pk, n.rho, n.rcm]);
        expect(buildNoteCommitment(P, n)).toBe(expected);
    });

    it("rejects out-of-range asset / value", () => {
        const bad = { asset: 1n << 64n, value: 0n, pk: 0n, rho: 0n, rcm: 0n };
        expect(() => buildNoteCommitment(P, bad)).toThrow();
        const bad2 = { asset: 0n, value: 1n << 64n, pk: 0n, rho: 0n, rcm: 0n };
        expect(() => buildNoteCommitment(P, bad2)).toThrow();
    });

    it("Merkle empty-root and proof verify", () => {
        const t = new MerkleTree(P, 4);
        const empty = t.root();
        // empty root = z_4
        let z = 0n;
        for (let i = 0; i < 4; i++) z = P.hash([5n, z, z, z, z]);
        expect(empty).toBe(z);

        t.insert(123n);
        t.insert(456n);
        const idx = t.insert(789n);
        const { pathElements, pathIndices } = t.proof(idx);

        // Reconstruct root from proof.
        let cur = 789n;
        for (let level = 0; level < 4; level++) {
            const sibs = pathElements[level];
            const pos = pathIndices[level];
            const children: bigint[] = [];
            let si = 0;
            for (let k = 0; k < 4; k++) {
                children.push(k === pos ? cur : sibs[si++]);
            }
            cur = P.hash([5n, children[0], children[1], children[2], children[3]]);
        }
        expect(cur).toBe(t.root());
    });

    it("H_BASE is on Baby-Jubjub subgroup", () => {
        expect(J.inSubgroup(H_BASE)).toBe(true);
    });

    it("hashToAssetGen rejects asset_id ≥ 2^254", () => {
        expect(() => J.hashToAssetGen(1n << 254n)).toThrow();
    });

    it("valueCommit is additively homomorphic", () => {
        const gen = J.hashToAssetGen(7n);
        const a = J.valueCommit(10n, gen, 100n);
        const b = J.valueCommit(20n, gen, 200n);
        const sum = J.valueCommit(30n, gen, 300n);
        expect(J.addPoint(a, b)).toEqual(sum);
    });
});
