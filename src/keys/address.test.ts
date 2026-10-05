import { bech32m } from "bech32";
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { shieldedAddress } from "../core/brand.js";
import { FIELD_BYTES, toLeBytes } from "../core/bytes.js";
import { BN254_FR } from "../core/field.js";
import { DIVERSIFIER_BYTES } from "../crypto/diversified-base.js";
import { Jubjub, Poseidon } from "../crypto/index.js";
import { InvalidArgumentError } from "../errors/config.js";
import { isWalletError } from "../errors/guard.js";
import { ADDRESS_HRP, type DecodedAddress, decodeAddress, encodeAddress } from "./address.js";
import { buildDiversifiedKeys } from "./diversified.js";
import {
    DIVERSIFIER_INDEX_BOUND,
    deriveDiversifierKey,
    diversifierAt,
    diversifierToField,
} from "./diversifier.js";
import { addressFromViewingKey, buildSpendingKey } from "./keys.js";
import { FVK_HRP, IVK_HRP } from "./viewing-key.js";

/** A non-zero canonical field element, as every root key scalar must be. */
const nskArb = fc.bigInt({ min: 1n, max: BN254_FR - 1n });
const indexArb = fc.integer({ min: 0, max: DIVERSIFIER_INDEX_BOUND - 1 });

const PAYLOAD_LEN = DIVERSIFIER_BYTES + 3 * FIELD_BYTES;
const IDENTITY = [0n, 1n] as [bigint, bigint];

/** The payload bytes of a bech32m string. */
function payloadOf(addr: string): Uint8Array {
    return new Uint8Array(bech32m.fromWords(bech32m.decode(addr, 256).words));
}

/** `payload` as a bech32m string under `hrp`, with no validation. */
function encodePayload(payload: Uint8Array, hrp = ADDRESS_HRP): string {
    return bech32m.encode(hrp, bech32m.toWords(payload), 256);
}

/** An unrelated HRP, the address HRP cut short, and the viewing-key HRPs, which extend it. */
const OTHER_HRPS = ["evil", "lelanto", IVK_HRP, FVK_HRP];

/** The four fields an address carries. */
function published({ d, pk_d, pk, ck_d }: DecodedAddress): DecodedAddress {
    return { d, pk_d, pk, ck_d };
}

describe("bech32m address", () => {
    let P: Poseidon;
    let J: Jubjub;
    beforeAll(async () => {
        P = await Poseidon.build();
        J = await Jubjub.build();
    });

    /** The keys of `nsk`'s address at `index`, from the definition of each field. */
    const addressKeys = (nsk: bigint, index = 0) => {
        const { ivk } = buildSpendingKey(P, nsk);
        const d = diversifierToField(diversifierAt(deriveDiversifierKey(ivk), index));
        return buildDiversifiedKeys(P, J, ivk, d);
    };

    /** `a` laid out in wire order under `hrp`, with no validation. */
    const encodeRaw = (a: DecodedAddress, hrp = ADDRESS_HRP) => {
        const payload = new Uint8Array(PAYLOAD_LEN);
        payload.set(toLeBytes(a.d, DIVERSIFIER_BYTES), 0);
        payload.set(J.packPoint(a.pk_d), DIVERSIFIER_BYTES);
        payload.set(toLeBytes(a.pk), DIVERSIFIER_BYTES + FIELD_BYTES);
        payload.set(J.packPoint(a.ck_d), DIVERSIFIER_BYTES + 2 * FIELD_BYTES);
        return encodePayload(payload, hrp);
    };

    /** `pk_d || pk || ck_d`: the 96 bytes of `a` after its diversifier. */
    const withoutDiversifier = (a: DecodedAddress) =>
        payloadOf(encodeRaw(a)).slice(DIVERSIFIER_BYTES);

    it.each([0, 1, 2 ** 32 - 1])("round-trip at index %d carries d, pk_d, pk, ck_d", (index) => {
        const keys = addressKeys(0xdeadbeefn, index);
        const addr = encodeAddress(J, keys);
        expect(bech32m.decode(addr, 256).prefix).toBe("lelantos");
        // Typed from `ADDRESS_HRP`: `tsc` refuses a brand whose template type names another prefix.
        const branded: `${typeof ADDRESS_HRP}1${string}` = shieldedAddress(addr);
        expect(branded).toBe(addr);
        expect(decodeAddress(J, addr)).toEqual(published(keys));
    });

    it("is a 112-byte payload, 195 characters, in the order d || pk_d || pk || ck_d", () => {
        const keys = addressKeys(0xdeadbeefn, 1);
        const addr = encodeAddress(J, keys);
        expect(addr).toHaveLength(195);
        expect(addr).toBe(encodeRaw(keys));
        expect(payloadOf(addr)).toHaveLength(PAYLOAD_LEN);
    });

    it("gives one account distinct addresses with no field in common", () => {
        const [a, b] = [addressKeys(42n, 0), addressKeys(42n, 1)];
        expect(encodeAddress(J, a)).not.toBe(encodeAddress(J, b));
        expect(a.d).not.toBe(b.d);
        expect(a.pk).not.toBe(b.pk);
        expect(a.pk_d).not.toEqual(b.pk_d);
        expect(a.ck_d).not.toEqual(b.ck_d);
    });

    it("carries no detection material: dk is absent from the payload", () => {
        const sk = buildSpendingKey(P, 0xdeadbeefn);
        const payload = payloadOf(addressFromViewingKey(P, J, sk));
        // The root detection secret must not appear at any offset, in either byte order.
        const dkLe = toLeBytes(sk.dk);
        const dkBe = Uint8Array.from(dkLe).reverse();
        for (let off = 0; off + FIELD_BYTES <= payload.length; off++) {
            const window = payload.slice(off, off + FIELD_BYTES);
            expect(window).not.toEqual(dkLe);
            expect(window).not.toEqual(dkBe);
        }
    });

    it("addressFromViewingKey matches manual encode", () => {
        const sk = buildSpendingKey(P, 42n);
        expect(addressFromViewingKey(P, J, sk)).toBe(encodeAddress(J, addressKeys(42n, 0)));
        expect(addressFromViewingKey(P, J, sk, 7)).toBe(encodeAddress(J, addressKeys(42n, 7)));
    });

    it("refuses to encode a d that is not a 16-byte diversifier", () => {
        const keys = addressKeys(1n);
        expect(() => encodeAddress(J, { ...keys, d: 1n << 128n })).toThrow(/16-byte diversifier/);
        expect(() => encodeAddress(J, { ...keys, d: -1n })).toThrow(InvalidArgumentError);
    });

    it.each(OTHER_HRPS)("rejects an address payload under the `%s` HRP", (hrp) => {
        // The checksum is valid under `hrp`, so only the prefix check rejects it.
        const addr = encodeRaw(addressKeys(1n), hrp);
        expect(() => decodeAddress(J, addr)).toThrow(
            `expected the "lelantos" prefix, got "${hrp}"`,
        );
        expect(() => shieldedAddress(addr)).toThrow(InvalidArgumentError);
    });

    it("checks the prefix ahead of the payload length", () => {
        const addr = encodePayload(withoutDiversifier(addressKeys(1n)), IVK_HRP);
        expect(() => decodeAddress(J, addr)).toThrow('expected the "lelantos" prefix');
    });

    it("rejects a 96-byte payload: pk_d || pk || ck_d with no diversifier", () => {
        // A valid checksum under the address HRP, so only the length check rejects it.
        const addr = encodePayload(withoutDiversifier(addressKeys(7n)));

        let thrown: unknown;
        try {
            decodeAddress(J, addr);
        } catch (err) {
            thrown = err;
        }
        if (!isWalletError(thrown, "INVALID_ARGUMENT"))
            throw new Error("expected INVALID_ARGUMENT");
        expect(thrown.argument).toBe("address");
        expect(thrown.message).toBe(
            "invalid shielded address: bad payload length 96, expected 112",
        );
    });

    it("rejects a payload one byte short or long", () => {
        const payload = payloadOf(encodeAddress(J, addressKeys(7n)));
        for (const bytes of [payload.slice(0, -1), new Uint8Array([...payload, 0])]) {
            expect(() => decodeAddress(J, encodePayload(bytes))).toThrow(/bad payload length/);
        }
    });

    it("rejects a payload with a field scalar in a point slot", () => {
        // Same 112-byte length, so only point validation rejects it. `2^255 - 1` is above the
        // base-field modulus, so it is not the canonical encoding of any ordinate.
        const keys = addressKeys(7n);
        const scalar = toLeBytes((1n << 255n) - 1n);
        for (const [name, offset] of [
            ["pk_d", DIVERSIFIER_BYTES],
            ["ck_d", DIVERSIFIER_BYTES + 2 * FIELD_BYTES],
        ] as const) {
            const payload = payloadOf(encodeAddress(J, keys));
            payload.set(scalar, offset);
            const addr = encodePayload(payload);
            expect(() => decodeAddress(J, addr)).toThrow(new RegExp(`${name} not`));
            expect(() => decodeAddress(J, addr)).toThrow(InvalidArgumentError);
        }
    });

    it("rejects an identity clue key", () => {
        // An identity `ck_d` makes every clue bit computable from the clue's `R`. `unpackPoint`
        // rejects it first; the explicit identity check in `decodeAddress` is a backstop.
        const addr = encodeRaw({ ...addressKeys(9n), ck_d: IDENTITY });
        expect(() => decodeAddress(J, addr)).toThrow(/\bck_d (not|is)\b/);
    });

    it("rejects an identity ECDH key", () => {
        const addr = encodeRaw({ ...addressKeys(9n), pk_d: IDENTITY });
        expect(() => decodeAddress(J, addr)).toThrow(/\bpk_d (not|is)\b/);
    });

    it("rejects a point outside the prime-order subgroup", () => {
        // The cofactor is 8, so the first small ordinates include a point outside the subgroup.
        const keys = addressKeys(9n);
        let outside: [bigint, bigint] | undefined;
        for (let y = 2n; outside === undefined; y++) {
            const p = J.unpackPoint(toLeBytes(y));
            if (p && !J.inSubgroup(p)) outside = p;
        }
        for (const slot of ["pk_d", "ck_d"] as const) {
            const addr = encodeRaw({ ...keys, [slot]: outside });
            expect(() => decodeAddress(J, addr)).toThrow(
                new RegExp(`${slot} not in prime subgroup`),
            );
        }
    });

    it("rejects a pk that is not a canonical field element", () => {
        const keys = addressKeys(9n);
        for (const pk of [BN254_FR, (1n << 256n) - 1n]) {
            const addr = encodeRaw({ ...keys, pk });
            expect(() => decodeAddress(J, addr)).toThrow(/address pk/);
            expect(() => decodeAddress(J, addr)).toThrow(InvalidArgumentError);
        }
    });

    // Addresses are user input, so every malformed case must surface as a typed error. The
    // bech32 library throws an untyped error, which must be wrapped.
    it("reports every malformed address as INVALID_ARGUMENT", () => {
        const keys = addressKeys(1n);
        const good = encodeAddress(J, keys);
        const malformed = [
            "",
            "not-an-address",
            good.slice(0, -1), // bad checksum — thrown by `bech32m.decode`
            ...OTHER_HRPS.map((hrp) => encodeRaw(keys, hrp)),
            encodePayload(withoutDiversifier(keys)), // 96 bytes
            encodePayload(new Uint8Array(8)), // short
            encodeRaw({ ...keys, ck_d: IDENTITY }),
        ];
        for (const addr of malformed) {
            let thrown: unknown;
            try {
                decodeAddress(J, addr);
            } catch (err) {
                thrown = err;
            }
            expect(isWalletError(thrown, "INVALID_ARGUMENT"), `for ${JSON.stringify(addr)}`).toBe(
                true,
            );
            // Narrows the type; `argument` names the offending input.
            if (!isWalletError(thrown, "INVALID_ARGUMENT")) throw new Error("unreachable");
            expect(thrown.argument).toBe("address");
        }
    });

    // bech32 requires a decoder to read the all-uppercase spelling, which QR codes use.
    it("decodes the all-uppercase spelling to the same fields, and rejects mixed case", () => {
        const keys = addressKeys(1n, 3);
        const good = encodeAddress(J, keys);

        expect(decodeAddress(J, good.toUpperCase())).toEqual(published(keys));

        const mixed = `${good.slice(0, 20)}${good.slice(20).toUpperCase()}`;
        expect(() => decodeAddress(J, mixed)).toThrow(InvalidArgumentError);
    });

    it("keeps the address out of the message, which reaches logs verbatim", () => {
        const bad = `${encodeAddress(J, addressKeys(1n)).slice(0, -1)}q`;
        try {
            decodeAddress(J, bad);
            throw new Error("expected a throw");
        } catch (err) {
            expect(err).toBeInstanceOf(InvalidArgumentError);
            expect((err as InvalidArgumentError).message).not.toContain(bad);
        }
    });

    it("round-trips all four fields for any nsk and index", () => {
        // Covers the scalar and index space, exposing any offset error in the 112-byte payload.
        fc.assert(
            fc.property(nskArb, indexArb, (n, index) => {
                const keys = addressKeys(n, index);
                const decoded = decodeAddress(
                    J,
                    addressFromViewingKey(P, J, buildSpendingKey(P, n), index),
                );
                expect(decoded).toEqual(published(keys));
            }),
            { numRuns: 30 },
        );
    });
});
