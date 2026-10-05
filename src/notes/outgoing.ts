// The outgoing cipher key of an account, the root of the output secrets in `./seed.ts`.
//
//   ock = blake2b("lelantos.note.ock.v1" || nsk_le, 32)

import { blake2b } from "@noble/hashes/blake2";
import { toLeBytes } from "../core/bytes.js";
import type { Field } from "../crypto/poseidon.js";

const OCK_DOMAIN = new TextEncoder().encode("lelantos.note.ock.v1");

/**
 * The outgoing cipher key of the account `nsk` roots: the secret the randomness of every output
 * it sends derives from.
 *
 * As sensitive as a viewing key for what the account sent: with a payee's address, its holder
 * can open that payee's notes from this account. It grants no spend authority and reveals
 * nothing about incoming notes.
 */
export function deriveOutgoingKey(nsk: Field): Uint8Array {
    const h = blake2b.create({ dkLen: 32 });
    h.update(OCK_DOMAIN);
    h.update(toLeBytes(nsk));
    return h.digest();
}
