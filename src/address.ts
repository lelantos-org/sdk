// bech32m payment address.
//
//   HRP     "lelantos"
//   payload pk_d (32 B, Baby-Jubjub packed) || dk (32 B, little-endian)
//
// Shape mirrors Zcash unified addresses: a Baby-Jubjub public key for
// ECDH-based note encryption + the FMD detection key so any sender can
// build a clue.

import { bech32m } from "bech32";
import { Jubjub, type Field, type Point } from "./crypto/index";
import { FIELD_BYTES, fromLeBytes, toLeBytes } from "./crypto/bytes";

export const ADDRESS_HRP = "lelantos";
export const ADDRESS_PAYLOAD_LEN = 2 * FIELD_BYTES;
const BECH32_LIMIT = 256;

export interface DecodedAddress {
    pk_d: Point;
    dk: Field;
}

export function encodeAddress(J: Jubjub, pk_d: Point, dk: Field): string {
    const payload = new Uint8Array(ADDRESS_PAYLOAD_LEN);
    payload.set(J.packPoint(pk_d), 0);
    payload.set(toLeBytes(dk), FIELD_BYTES);
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

    return { pk_d, dk: fromLeBytes(payload.slice(FIELD_BYTES)) };
}
