import { blake2b } from "@noble/hashes/blake2";
import { describe, expect, it } from "vitest";
import { fromLeBytes, toLeBytes } from "../core/bytes.js";
import { BABYJUB_SUBGROUP_ORDER, BN254_FR, POW_2_64 } from "../core/field.js";
import { bytesToBareHex } from "../core/hex.js";
import { deriveOutgoingKey } from "./outgoing.js";
import {
    deriveDepositRho,
    deriveOutputSecret,
    type ExpandedSeed,
    expandSeed,
    type OutputSecretInputs,
    seedFromSecret,
} from "./seed.js";

const q = BABYJUB_SUBGROUP_ORDER;
const utf8 = (s: string) => new TextEncoder().encode(s);
const concat = (...parts: Uint8Array[]) => new Uint8Array(parts.flatMap((p) => [...p]));
const hex = bytesToBareHex;

const ock = deriveOutgoingKey(7n);
const note: OutputSecretInputs = {
    chainId: 8453n,
    rho: 99n,
    asset: 3n,
    value: 1_000_000n,
    d: Uint8Array.from({ length: 16 }, (_, i) => i + 1),
    pk_d: Uint8Array.from({ length: 32 }, (_, i) => 0x40 + i),
    pk: 123_456_789n,
    ck_d: Uint8Array.from({ length: 32 }, (_, i) => 0x80 + i),
    nullifiers: [0xa11n, 0xb22n],
    memo: Uint8Array.from({ length: 128 }, (_, i) => (i < 5 ? 0x61 + i : 0)),
};

/** `bytes` with the lowest bit of byte `at` flipped. */
function flipped(bytes: Uint8Array, at: number): Uint8Array {
    const out = bytes.slice();
    out[at]! ^= 1;
    return out;
}

/** What the output with secret `osk` and the fixture's `rho` expands to. */
function expansionOf(osk: Uint8Array): ExpandedSeed {
    return expandSeed(seedFromSecret(osk), note.rho);
}

/** `got` shares no derived value with `base`. */
function expectUnrelated(got: ExpandedSeed, base: ExpandedSeed): void {
    expect(got.rcm).not.toBe(base.rcm);
    expect(got.esk).not.toBe(base.esk);
    expect(got.fmdR).not.toBe(base.fmdR);
}

describe("deriveOutputSecret", () => {
    it("is a fixed 32-byte function of its inputs", () => {
        const osk = deriveOutputSecret(ock, note);
        expect(osk).toHaveLength(32);
        expect(deriveOutputSecret(ock, { ...note })).toEqual(osk);
    });

    // An independent concatenation, so the field order and every width are pinned.
    it("hashes ock, chainId, rho, asset, value, d, pk_d, pk, ck_d, the counted nullifiers and the memo in that order", () => {
        const preimage = concat(
            utf8("lelantos.note.osk.v3"),
            ock,
            toLeBytes(note.chainId, 32),
            toLeBytes(note.rho, 32),
            toLeBytes(note.asset, 8),
            toLeBytes(note.value, 8),
            note.d,
            note.pk_d,
            toLeBytes(note.pk, 32),
            note.ck_d,
        );
        const withNullifiers = concat(
            preimage,
            Uint8Array.of(2),
            toLeBytes(0xa11n, 32),
            toLeBytes(0xb22n, 32),
            note.memo,
        );
        expect(withNullifiers).toHaveLength(
            20 + 32 + 32 + 32 + 8 + 8 + (16 + 32 + 32 + 32) + 1 + 2 * 32 + 128,
        );
        expect(deriveOutputSecret(ock, note)).toEqual(blake2b(withNullifiers, { dkLen: 32 }));
        // An empty list hashes its count, zero.
        expect(deriveOutputSecret(ock, { ...note, nullifiers: [] })).toEqual(
            blake2b(concat(preimage, Uint8Array.of(0), note.memo), { dkLen: 32 }),
        );
    });

    it("binds every nullifier, their order and their number", () => {
        const [a, b] = [0xa11n, 0xb22n];
        const lists = [
            [a, b],
            [a + 1n, b],
            [a, b + 1n],
            [b, a],
            [a],
            [a, b, 0n],
            [],
            [0n],
            [0n, 0n],
        ];
        const all = lists.map((nullifiers) =>
            hex(deriveOutputSecret(ock, { ...note, nullifiers })),
        );
        expect(new Set(all).size).toBe(lists.length);

        // The change reaches every derived value.
        const expand = (nullifiers: bigint[]) =>
            expansionOf(deriveOutputSecret(ock, { ...note, nullifiers }));
        const base = expand([a, b]);
        for (const other of [expand([a, b + 1n]), expand([b, a])]) expectUnrelated(other, base);
    });

    it("accepts up to 255 canonical nullifiers and rejects any other list", () => {
        const many = (n: number) => Array.from({ length: n }, (_, i) => BigInt(i));
        expect(deriveOutputSecret(ock, { ...note, nullifiers: many(255) })).toHaveLength(32);
        expect(deriveOutputSecret(ock, { ...note, nullifiers: [BN254_FR - 1n] })).toHaveLength(32);
        expect(() => deriveOutputSecret(ock, { ...note, nullifiers: many(256) })).toThrow(
            /nullifiers\.length must be at most 255/,
        );
        for (const bad of [BN254_FR, -1n]) {
            expect(() => deriveOutputSecret(ock, { ...note, nullifiers: [1n, bad] })).toThrow(
                /nullifiers\[1\] must be a canonical field element/,
            );
        }
    });

    it("changes with every single input", () => {
        const variants = [
            deriveOutputSecret(deriveOutgoingKey(8n), note),
            deriveOutputSecret(ock, { ...note, chainId: note.chainId + 1n }),
            deriveOutputSecret(ock, { ...note, rho: note.rho + 1n }),
            deriveOutputSecret(ock, { ...note, asset: note.asset + 1n }),
            deriveOutputSecret(ock, { ...note, value: note.value + 1n }),
            deriveOutputSecret(ock, { ...note, d: flipped(note.d, 15) }),
            deriveOutputSecret(ock, { ...note, pk_d: flipped(note.pk_d, 0) }),
            deriveOutputSecret(ock, { ...note, pk_d: flipped(note.pk_d, 31) }),
            deriveOutputSecret(ock, { ...note, pk: note.pk + 1n }),
            deriveOutputSecret(ock, { ...note, ck_d: flipped(note.ck_d, 0) }),
            deriveOutputSecret(ock, { ...note, ck_d: flipped(note.ck_d, 31) }),
            deriveOutputSecret(ock, { ...note, memo: flipped(note.memo, 0) }),
            deriveOutputSecret(ock, { ...note, memo: flipped(note.memo, 127) }),
            deriveOutputSecret(ock, { ...note, memo: new Uint8Array(128) }),
            // asset and value are adjacent 8-byte fields: swapping them must not collide.
            deriveOutputSecret(ock, { ...note, asset: note.value, value: note.asset }),
            // Likewise the two 32-byte points.
            deriveOutputSecret(ock, { ...note, pk_d: note.ck_d, ck_d: note.pk_d }),
        ];
        const all = [deriveOutputSecret(ock, note), ...variants].map(hex);
        expect(new Set(all).size).toBe(all.length);

        // The change reaches every derived value.
        const base = expansionOf(deriveOutputSecret(ock, note));
        for (const osk of variants) expectUnrelated(expansionOf(osk), base);
    });

    it("accepts the uint64 bounds and rejects values past them", () => {
        const max = POW_2_64 - 1n;
        expect(deriveOutputSecret(ock, { ...note, asset: max, value: max })).toHaveLength(32);
        expect(deriveOutputSecret(ock, { ...note, asset: 0n, value: 0n })).toHaveLength(32);
        for (const bad of [POW_2_64, -1n]) {
            expect(() => deriveOutputSecret(ock, { ...note, asset: bad })).toThrow(
                /asset must be a 64-bit unsigned integer/,
            );
            expect(() => deriveOutputSecret(ock, { ...note, value: bad })).toThrow(
                /value must be a 64-bit unsigned integer/,
            );
        }
    });

    it("rejects malformed inputs", () => {
        expect(() => deriveOutputSecret(ock.slice(1), note)).toThrow(/ock must be 32 bytes/);
        expect(() => deriveOutputSecret(ock, { ...note, d: new Uint8Array(15) })).toThrow(
            /d must be 16 bytes/,
        );
        expect(() => deriveOutputSecret(ock, { ...note, d: new Uint8Array(32) })).toThrow(
            /d must be 16 bytes/,
        );
        for (const bad of [new Uint8Array(31), new Uint8Array(33), new Uint8Array(64)]) {
            expect(() => deriveOutputSecret(ock, { ...note, pk_d: bad })).toThrow(
                /pk_d must be 32 bytes/,
            );
            expect(() => deriveOutputSecret(ock, { ...note, ck_d: bad })).toThrow(
                /ck_d must be 32 bytes/,
            );
        }
        for (const bad of [new Uint8Array(0), new Uint8Array(127), new Uint8Array(129)]) {
            expect(() => deriveOutputSecret(ock, { ...note, memo: bad })).toThrow(
                /memo must be 128 bytes/,
            );
        }
        expect(() => deriveOutputSecret(ock, { ...note, rho: BN254_FR })).toThrow(/rho must be/);
        expect(() => deriveOutputSecret(ock, { ...note, pk: BN254_FR })).toThrow(/pk must be/);
        expect(() => deriveOutputSecret(ock, { ...note, chainId: -1n })).toThrow(/chainId must be/);
        expect(() => deriveOutputSecret(ock, { ...note, chainId: 1n << 256n })).toThrow(
            /chainId must be/,
        );
    });
});

describe("seedFromSecret", () => {
    it("is blake2b-256 of the domain and osk", () => {
        const osk = deriveOutputSecret(ock, note);
        const rseed = seedFromSecret(osk);
        expect(rseed).toEqual(blake2b(concat(utf8("lelantos.note.rseed.v2"), osk), { dkLen: 32 }));
        expect(rseed).not.toEqual(osk);
        expect(() => seedFromSecret(osk.slice(1))).toThrow(/osk must be 32 bytes/);
    });
});

describe("expandSeed", () => {
    const rseed = seedFromSecret(deriveOutputSecret(ock, note));

    it("is deterministic, so the recipient gets the sender's values", () => {
        const sender = expandSeed(rseed, note.rho);
        // The recipient holds only what the plaintext carries: a copy of rseed, and rho.
        const recipient = expandSeed(Uint8Array.from(rseed), note.rho);
        expect(recipient).toEqual(sender);
    });

    it("reduces three domain-separated 512-bit digests", () => {
        const tail = concat(rseed, toLeBytes(note.rho, 32));
        const wide = (domain: string) =>
            fromLeBytes(blake2b(concat(utf8(domain), tail), { dkLen: 64 }));
        expect(expandSeed(rseed, note.rho)).toEqual({
            rcm: wide("lelantos.note.rcm.v2") % BN254_FR,
            esk: 1n + (wide("lelantos.note.esk.v2") % (q - 1n)),
            fmdR: 1n + (wide("lelantos.note.fmdr.v2") % (q - 1n)),
        });
    });

    it("keeps esk and fmdR in [1, q - 1] and rcm below the field modulus", () => {
        for (let i = 0; i < 256; i++) {
            const seed = blake2b(Uint8Array.of(i), { dkLen: 32 });
            const { rcm, esk, fmdR } = expandSeed(seed, BigInt(i));
            for (const scalar of [esk, fmdR]) {
                expect(scalar).toBeGreaterThanOrEqual(1n);
                expect(scalar).toBeLessThanOrEqual(q - 1n);
            }
            expect(rcm).toBeGreaterThanOrEqual(0n);
            expect(rcm).toBeLessThan(BN254_FR);
            expect(esk).not.toBe(fmdR);
        }
    });

    it("changes every output with rseed and with rho", () => {
        const base = expandSeed(rseed, note.rho);
        const otherSeed = rseed.slice();
        otherSeed[0]! ^= 1;
        for (const got of [expandSeed(otherSeed, note.rho), expandSeed(rseed, note.rho + 1n)]) {
            expectUnrelated(got, base);
        }
    });

    it("rejects malformed inputs", () => {
        expect(() => expandSeed(rseed.slice(1), note.rho)).toThrow(/rseed must be 32 bytes/);
        expect(() => expandSeed(rseed, BN254_FR)).toThrow(/rho must be/);
    });
});

describe("deriveDepositRho", () => {
    const nonce = Uint8Array.from({ length: 32 }, (_, i) => 0xa0 + i);

    it("is a field element fixed by ock and the nonce", () => {
        const rho = deriveDepositRho(ock, nonce);
        expect(deriveDepositRho(ock, nonce)).toBe(rho);
        expect(rho).toBeLessThan(BN254_FR);
        expect(rho).toBe(
            fromLeBytes(blake2b(concat(utf8("lelantos.note.rho.v2"), ock, nonce), { dkLen: 64 })) %
                BN254_FR,
        );
    });

    it("changes with the key and the nonce", () => {
        const otherNonce = nonce.slice();
        otherNonce[31]! ^= 1;
        const all = [
            deriveDepositRho(ock, nonce),
            deriveDepositRho(deriveOutgoingKey(8n), nonce),
            deriveDepositRho(ock, otherNonce),
        ];
        expect(new Set(all).size).toBe(all.length);
    });

    it("rejects a key or nonce that is not 32 bytes", () => {
        expect(() => deriveDepositRho(ock, nonce.slice(1))).toThrow(/nonce must be 32 bytes/);
        expect(() => deriveDepositRho(ock.slice(1), nonce)).toThrow(/ock must be 32 bytes/);
    });
});
