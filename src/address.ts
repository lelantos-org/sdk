// bech32m payment address.
//
//   HRP     "lelantos2"
//   payload pk_d (32 B, Baby-Jubjub packed)
//        || dk  (32 B, little-endian field scalar — FMD detection seed)
//        || pk  (32 B, little-endian field scalar — note-commitment binding)
//
// HRP carries the format version: bumping it (`lelantos` → `lelantos2`)
// invalidates old strings and lets future format changes fail-fast.
//
// `pk = Poseidon(TAG_PK, ivk)` is exposed so that any sender can construct
// a valid note commitment for the recipient. Spend authority remains gated
// solely by `nsk` (the nullifier check uses `nsk`, not `pk`); publishing
// `pk` does not enable forgery and does not worsen linkability beyond what
// `pk_d` already exposes — see the audit in PR description.

import { bech32m } from "bech32";
import { Jubjub, type Field, type Point } from "./crypto/index";
import { FIELD_BYTES, fromLeBytes, toLeBytes } from "./crypto/bytes";

export const ADDRESS_HRP = "lelantos2";
export const ADDRESS_PAYLOAD_LEN = 3 * FIELD_BYTES;
const BECH32_LIMIT = 256;

export interface DecodedAddress {
    pk_d: Point;
    dk: Field;
    pk: Field;
}

export function encodeAddress(J: Jubjub, pk_d: Point, dk: Field, pk: Field): string {
    const payload = new Uint8Array(ADDRESS_PAYLOAD_LEN);
    payload.set(J.packPoint(pk_d), 0);
    payload.set(toLeBytes(dk), FIELD_BYTES);
    payload.set(toLeBytes(pk), 2 * FIELD_BYTES);
    return bech32m.encode(ADDRESS_HRP, bech32m.toWords(payload), BECH32_LIMIT);
}

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
