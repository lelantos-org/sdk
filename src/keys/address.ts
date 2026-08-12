// bech32m payment address.
//
//   HRP     "sswap"
//   payload pk_d (32 B, Baby-Jubjub packed)
//        || dk  (32 B, little-endian field scalar — FMD detection seed)
//        || pk  (32 B, little-endian field scalar — note-commitment binding)
//
// HRP carries the format version: bumping it invalidates old strings and
// lets format changes fail-fast.
//
// `pk = Poseidon(TAG_PK, ivk)` is exposed so any sender can construct a
// valid note commitment for the recipient. Spend authority remains gated
// solely by `nsk` (nullifier check uses `nsk`, not `pk`); publishing `pk`
// does not enable forgery and does not worsen linkability beyond `pk_d`.

import { bech32m } from "bech32";
import { branded, type ShieldedAddress } from "../core/brand.js";
import { FIELD_BYTES, fromLeBytes, toLeBytes } from "../crypto/bytes.js";
import type { Jubjub, Point } from "../crypto/jubjub.js";
import type { Field } from "../crypto/poseidon.js";

export const ADDRESS_HRP = "sswap";
/** @internal */
export const ADDRESS_PAYLOAD_LEN = 3 * FIELD_BYTES;
const BECH32_LIMIT = 256;

/** @internal */
export interface DecodedAddress {
    pk_d: Point;
    dk: Field;
    pk: Field;
}

/** @internal */
export function encodeAddress(J: Jubjub, pk_d: Point, dk: Field, pk: Field): ShieldedAddress {
    const payload = new Uint8Array(ADDRESS_PAYLOAD_LEN);
    payload.set(J.packPoint(pk_d), 0);
    payload.set(toLeBytes(dk), FIELD_BYTES);
    payload.set(toLeBytes(pk), 2 * FIELD_BYTES);
    return branded<ShieldedAddress>(
        bech32m.encode(ADDRESS_HRP, bech32m.toWords(payload), BECH32_LIMIT),
    );
}

/** @internal */
export function decodeAddress(J: Jubjub, addr: string): DecodedAddress {
    const { prefix, words } = bech32m.decode(addr, BECH32_LIMIT);
    if (prefix !== ADDRESS_HRP) throw new Error(`bad HRP: ${prefix}`);

    const payload = new Uint8Array(bech32m.fromWords(words));
    if (payload.length !== ADDRESS_PAYLOAD_LEN) {
        throw new Error(`bad payload length: ${payload.length}`);
    }

    const pk_d = J.unpackPoint(payload.slice(0, FIELD_BYTES));
    if (!pk_d) throw new Error("pk_d not on Baby-Jubjub");
    if (!J.inSubgroup(pk_d)) throw new Error("pk_d not in prime subgroup");

    const dk = fromLeBytes(payload.slice(FIELD_BYTES, 2 * FIELD_BYTES));
    const pk = fromLeBytes(payload.slice(2 * FIELD_BYTES));

    return { pk_d, dk, pk };
}
