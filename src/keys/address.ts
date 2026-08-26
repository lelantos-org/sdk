// bech32m payment address.
//
//   HRP     "lelantos"
//   payload pk_d (32 B, Baby-Jubjub packed — ECDH target)
//        || pk   (32 B, little-endian field scalar — note-commitment binding)
//        || ck   (32 B, Baby-Jubjub packed — FMD clue key)
//
// HRP carries the format version: bumping it invalidates old strings and
// lets format changes fail-fast.
//
// `pk = Poseidon(TAG_PK, ivk)` is exposed so any sender can construct a
// valid note commitment for the recipient. Spend authority remains gated
// solely by `nsk` (nullifier check uses `nsk`, not `pk`); publishing `pk`
// does not enable forgery and does not worsen linkability beyond `pk_d`.
//
// `ck = dk · Base8` is the public half of the FMD key. Senders expand it into
// flag-key points (`fmdExpandFlagKey`) to build a clue; recovering the
// detection scalars from it requires a discrete log, so the address confers
// the ability to flag a recipient but not to detect for them. The detection
// secret `dk` must never appear in an address.
//
// Both point fields are validated on decode (on-curve, prime-order subgroup,
// non-identity). A payload carrying a field scalar in the `ck` slot therefore
// fails to decode rather than yielding a usable address.

import { bech32m } from "bech32";
import { branded, type ShieldedAddress } from "../core/brand.js";
import { InvalidArgumentError } from "../core/errors.js";
import { assertField } from "../core/field.js";
import { FIELD_BYTES, fromLeBytes, toLeBytes } from "../crypto/bytes.js";
import type { Jubjub, Point } from "../crypto/jubjub.js";
import type { Field } from "../crypto/poseidon.js";

export const ADDRESS_HRP = "lelantos";
/** @internal */
export const ADDRESS_PAYLOAD_LEN = 3 * FIELD_BYTES;
const BECH32_LIMIT = 256;

export interface DecodedAddress {
    pk_d: Point;
    pk: Field;
    ck: Point;
}

export function encodeAddress(J: Jubjub, pk_d: Point, pk: Field, ck: Point): ShieldedAddress {
    const payload = new Uint8Array(ADDRESS_PAYLOAD_LEN);
    payload.set(J.packPoint(pk_d), 0);
    payload.set(toLeBytes(pk), FIELD_BYTES);
    payload.set(J.packPoint(ck), 2 * FIELD_BYTES);
    return branded<ShieldedAddress>(
        bech32m.encode(ADDRESS_HRP, bech32m.toWords(payload), BECH32_LIMIT),
    );
}

/**
 * Decode a payment address, validating both point slots.
 *
 * Every failure is an {@link InvalidArgumentError}: an address reaching here is
 * something a user typed, pasted or was handed by a payee, so a malformed one
 * is the caller's to report — not an SDK invariant. `bech32m.decode` throws its
 * library's own untyped error on a bad checksum or charset, which is why the
 * whole body is wrapped rather than only the checks below it.
 *
 * The address itself is left out of the message: it reaches application logs
 * verbatim, and an address names a payee.
 */
export function decodeAddress(J: Jubjub, addr: string): DecodedAddress {
    try {
        return decode(J, addr);
    } catch (err) {
        if (err instanceof InvalidArgumentError) throw err;
        // The bech32 layer's own message quotes the whole address back
        // ("Invalid checksum for lelantos1…"), so it is kept on `cause` rather
        // than forwarded into a message that reaches logs.
        throw new InvalidArgumentError("invalid shielded address: not valid bech32m", {
            argument: "address",
            cause: err,
        });
    }
}

function decode(J: Jubjub, addr: string): DecodedAddress {
    const { prefix, words } = bech32m.decode(addr, BECH32_LIMIT);
    if (prefix !== ADDRESS_HRP) {
        throw new InvalidArgumentError(
            `invalid shielded address: expected the "${ADDRESS_HRP}" prefix, got "${prefix}"`,
            { argument: "address" },
        );
    }

    const payload = new Uint8Array(bech32m.fromWords(words));
    if (payload.length !== ADDRESS_PAYLOAD_LEN) {
        throw new InvalidArgumentError(
            `invalid shielded address: bad payload length ${payload.length}, ` +
                `expected ${ADDRESS_PAYLOAD_LEN}`,
            { argument: "address" },
        );
    }

    const pk_d = unpackChecked(J, payload.slice(0, FIELD_BYTES), "pk_d");
    // The two point slots are validated by `unpackChecked`; the scalar slot
    // needs its own range check. An unreduced `pk` decodes cleanly and the
    // sender then commits to `pk mod r`, while the recipient derives a
    // canonical `pk` from their `ivk` — a note the sender believes delivered
    // and the recipient cannot spend.
    const pk = fromLeBytes(payload.slice(FIELD_BYTES, 2 * FIELD_BYTES));
    assertField(pk, "address pk");
    const ck = unpackChecked(J, payload.slice(2 * FIELD_BYTES), "ck");

    return { pk_d, pk, ck };
}

// Rejects the identity alongside the usual curve checks: an identity `ck`
// expands to flag-key points with a known discrete log, which makes every
// clue bit predictable.
function unpackChecked(J: Jubjub, bytes: Uint8Array, name: string): Point {
    const bad = (why: string): never => {
        throw new InvalidArgumentError(`invalid shielded address: ${name} ${why}`, {
            argument: "address",
        });
    };
    const p = J.unpackPoint(bytes);
    if (!p) return bad("not on Baby-Jubjub");
    if (!J.inSubgroup(p)) return bad("not in prime subgroup");
    if (p[0] === 0n && p[1] === 1n) return bad("is the identity");
    return p;
}
