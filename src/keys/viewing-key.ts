// bech32m viewing keys.
//
//   HRP     "lelantosivk"  payload version (1 B) || ivk (32 B, little-endian)
//   HRP     "lelantosfvk"  payload version (1 B) || ivk (32 B) || nk (32 B)
//
// The payload carries only the secret scalars; `pk`, `pk_d`, `dk` and `ck`
// derive from `ivk` and are recomputed on decode. The HRP marks the tier, the
// version byte a format change that keeps the prefix.
//
// Releasing a viewing key is permanent: `ivk` is fixed by `nsk`, so there is no
// rotation. The holder decrypts every note the account receives, and an FVK
// also sees which are spent. Neither grants spend authority.

import { bech32m } from "bech32";
import { branded, type ViewingKeyString } from "../core/brand.js";
import { FIELD_BYTES, fromLeBytes, toLeBytes } from "../core/bytes.js";
import { assertNonZeroField } from "../core/field.js";
import type { Jubjub } from "../crypto/jubjub.js";
import type { Field, Poseidon } from "../crypto/poseidon.js";
import { InvalidArgumentError } from "../errors/config.js";
import { BECH32_LIMIT, rethrowBech32 } from "./address.js";
import {
    buildFullViewingKey,
    buildViewingKey,
    type FullViewingKey,
    type ViewingKey,
} from "./keys.js";

export const IVK_HRP = "lelantosivk";
export const FVK_HRP = "lelantosfvk";

/** Payload format version. Bumped for a format change that keeps the HRP. */
const VERSION = 1;

const IVK_PAYLOAD_LEN = 1 + FIELD_BYTES;
const FVK_PAYLOAD_LEN = 1 + 2 * FIELD_BYTES;

/** Whether a decoded viewing key carries `nk`, and so can see spends. */
export function isFullViewingKey(vk: ViewingKey | FullViewingKey): vk is FullViewingKey {
    return "nk" in vk;
}

/** Encode an incoming viewing key. Grants detect + decrypt, not spend visibility. */
export function encodeViewingKey(vk: ViewingKey): ViewingKeyString {
    return encode(IVK_HRP, [vk.ivk]);
}

/** Encode a full viewing key. Adds spend visibility; still not spend authority. */
export function encodeFullViewingKey(fvk: FullViewingKey): ViewingKeyString {
    return encode(FVK_HRP, [fvk.ivk, fvk.nk]);
}

// The tiers differ only in the number of scalars following the version byte;
// `decode` checks the payload against the length that implies.
function encode(hrp: string, scalars: readonly Field[]): ViewingKeyString {
    const payload = new Uint8Array(1 + scalars.length * FIELD_BYTES);
    payload[0] = VERSION;
    for (const [i, v] of scalars.entries()) payload.set(toLeBytes(v), 1 + i * FIELD_BYTES);
    return branded<ViewingKeyString>(bech32m.encode(hrp, bech32m.toWords(payload), BECH32_LIMIT));
}

/**
 * Decode either tier, recomputing the derived key material.
 *
 * Returns a `FullViewingKey` for an `lelantosfvk1…` string, a `ViewingKey`
 * otherwise; narrow with {@link isFullViewingKey}. Failures are
 * {@link InvalidArgumentError}. The key is kept out of the message: it is
 * secret, and error text reaches application logs verbatim.
 */
export function decodeViewingKey(P: Poseidon, J: Jubjub, key: string): ViewingKey | FullViewingKey {
    return rethrowBech32(() => decode(P, J, key), "invalid viewing key", "viewingKey");
}

function decode(P: Poseidon, J: Jubjub, key: string): ViewingKey | FullViewingKey {
    const { prefix, words } = bech32m.decode(key, BECH32_LIMIT);
    if (prefix !== IVK_HRP && prefix !== FVK_HRP) {
        throw bad(`expected the "${IVK_HRP}" or "${FVK_HRP}" prefix, got "${prefix}"`);
    }

    const payload = new Uint8Array(bech32m.fromWords(words));
    const want = prefix === FVK_HRP ? FVK_PAYLOAD_LEN : IVK_PAYLOAD_LEN;
    if (payload.length !== want) {
        throw bad(`bad payload length ${payload.length}, expected ${want}`);
    }
    if (payload[0] !== VERSION) {
        throw bad(`unsupported payload version ${payload[0]}, expected ${VERSION}`);
    }

    // Non-zero, not merely in range: `ivk = 0` gives an identity `pk_d`, whose
    // notes are publicly decryptable, and `nk = 0` yields a nullifier
    // independent of the account.
    const ivk = scalar(payload.slice(1, 1 + FIELD_BYTES), "ivk");
    if (prefix === IVK_HRP) return buildViewingKey(P, J, ivk);
    return buildFullViewingKey(P, J, ivk, scalar(payload.slice(1 + FIELD_BYTES), "nk"));
}

function scalar(bytes: Uint8Array, name: string): Field {
    const v = fromLeBytes(bytes);
    try {
        assertNonZeroField(v, name);
    } catch {
        throw bad(`${name} is not a canonical non-zero field element`);
    }
    return v;
}

function bad(why: string): InvalidArgumentError {
    return new InvalidArgumentError(`invalid viewing key: ${why}`, { argument: "viewingKey" });
}
