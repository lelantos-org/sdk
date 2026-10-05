// bech32m payment address.
//
//   HRP     "lelantos"
//   payload d    (16 B, little-endian — diversifier, selects the base point g_d)
//        || pk_d (32 B, Baby-Jubjub packed — ECDH target)
//        || pk   (32 B, little-endian field scalar — note-commitment binding)
//        || ck_d (32 B, Baby-Jubjub packed — FMD clue key)
//
// 112 bytes, 195 characters. A payload of any other length fails to decode.
//
// The fields are derived in `./diversified.ts`. A sender needs nothing else: `g_d` is a function
// of `d`, `pk` builds the recipient's note commitment, and `ck_d` expands into the flag key
// (`fmdDiversifiedFlagKey`). None of them grants spend or detection authority: spending rests on
// `nsk`, recovering the detection scalars from `ck_d` is a discrete log, and `dk_root` must never
// appear in an address. An account has one address per diversifier index in `[0, 2^32)`; two of
// them have no field in common.
//
// Both point slots are validated on decode: on-curve, prime-order subgroup, non-identity. Decoding
// does not establish that `pk`, `pk_d` and `ck_d` belong to one `ivk`, or that the points are
// multiples of `g_d`; only the holder of `ivk` can (`ownsAddress`).

import { bech32m } from "bech32";
import { branded, type ShieldedAddress } from "../core/brand.js";
import { FIELD_BYTES, fromLeBytes, toLeBytes } from "../core/bytes.js";
import { assertField } from "../core/field.js";
import { assertDiversifier, DIVERSIFIER_BYTES } from "../crypto/diversified-base.js";
import type { Jubjub, Point } from "../crypto/jubjub.js";
import type { Field } from "../crypto/poseidon.js";
import { InvalidArgumentError } from "../errors/config.js";

export const ADDRESS_HRP = "lelantos";
const PK_D_OFFSET = DIVERSIFIER_BYTES;
const PK_OFFSET = PK_D_OFFSET + FIELD_BYTES;
const CK_D_OFFSET = PK_OFFSET + FIELD_BYTES;
const ADDRESS_PAYLOAD_LEN = CK_D_OFFSET + FIELD_BYTES;
/** Length cap passed to `bech32m`, above its 90-character default. @internal */
export const BECH32_LIMIT = 256;

export interface DecodedAddress {
    /** The diversifier as an integer in `[0, 2^128)`. */
    d: Field;
    /** ECDH target, `(ivk mod q) · g_d`. */
    pk_d: Point;
    /** `Poseidon(TAG_PK, ivk, d)`: binds the note commitment. */
    pk: Field;
    /** FMD clue key, `dk_root · g_d`. */
    ck_d: Point;
}

/**
 * Encode a payment address. The points are not validated; `decodeAddress` rejects an encoding of
 * a point outside the prime-order subgroup or of the identity.
 *
 * @throws {InvalidArgumentError} when `d` is not in `[0, 2^128)` or `pk` exceeds 32 bytes.
 */
export function encodeAddress(J: Jubjub, a: DecodedAddress): ShieldedAddress {
    assertDiversifier(a.d);
    const payload = new Uint8Array(ADDRESS_PAYLOAD_LEN);
    payload.set(toLeBytes(a.d, DIVERSIFIER_BYTES), 0);
    payload.set(J.packPoint(a.pk_d), PK_D_OFFSET);
    payload.set(toLeBytes(a.pk), PK_OFFSET);
    payload.set(J.packPoint(a.ck_d), CK_D_OFFSET);
    return branded<ShieldedAddress>(
        bech32m.encode(ADDRESS_HRP, bech32m.toWords(payload), BECH32_LIMIT),
    );
}

/**
 * Decode a payment address, validating both point slots.
 *
 * Every failure is an `InvalidArgumentError` (`INVALID_ARGUMENT`). The message omits the address:
 * error text reaches application logs verbatim, and an address identifies a payee.
 */
export function decodeAddress(J: Jubjub, addr: string): DecodedAddress {
    return rethrowBech32(() => decode(J, addr), "invalid shielded address", "address");
}

/**
 * Run a bech32m decode, rethrowing the untyped error `bech32m` raises on a bad checksum or
 * charset as `InvalidArgumentError`. The library's message quotes the input, so it is kept on
 * `cause`, not in the message.
 *
 * @internal
 */
export function rethrowBech32<T>(decode: () => T, what: string, argument: string): T {
    try {
        return decode();
    } catch (err) {
        if (err instanceof InvalidArgumentError) throw err;
        throw new InvalidArgumentError(`${what}: not valid bech32m`, { argument, cause: err });
    }
}

function decode(J: Jubjub, addr: string): DecodedAddress {
    const { prefix, words } = bech32m.decode(addr, BECH32_LIMIT);
    if (prefix !== ADDRESS_HRP) {
        throw bad(`expected the "${ADDRESS_HRP}" prefix, got "${prefix}"`);
    }

    const payload = new Uint8Array(bech32m.fromWords(words));
    if (payload.length !== ADDRESS_PAYLOAD_LEN) {
        throw bad(`bad payload length ${payload.length}, expected ${ADDRESS_PAYLOAD_LEN}`);
    }

    // Every 16-byte string is a diversifier, so `d` needs no range check.
    const d = fromLeBytes(payload.slice(0, PK_D_OFFSET));
    const pk_d = unpackChecked(J, payload.slice(PK_D_OFFSET, PK_OFFSET), "pk_d");
    // Range check: an unreduced `pk` would make the sender commit to `pk mod r` while the
    // recipient derives a canonical `pk` from `ivk`, producing a note the recipient cannot spend.
    const pk = fromLeBytes(payload.slice(PK_OFFSET, CK_D_OFFSET));
    assertField(pk, "address pk");
    const ck_d = unpackChecked(J, payload.slice(CK_D_OFFSET), "ck_d");

    return { d, pk_d, pk, ck_d };
}

// Rejects the identity alongside the curve checks. An identity `pk_d` gives the shared secret
// `esk · O = O`, so anyone decrypts the note. An identity `ck_d` expands to flag-key points
// `h_i · g_d` with public `h_i`, which makes every clue bit computable from the clue's `R`.
function unpackChecked(J: Jubjub, bytes: Uint8Array, name: string): Point {
    const p = J.unpackPoint(bytes);
    if (!p) throw bad(`${name} not on Baby-Jubjub`);
    if (!J.inSubgroup(p)) throw bad(`${name} not in prime subgroup`);
    if (p[0] === 0n && p[1] === 1n) throw bad(`${name} is the identity`);
    return p;
}

function bad(why: string): InvalidArgumentError {
    return new InvalidArgumentError(`invalid shielded address: ${why}`, { argument: "address" });
}
