// Deterministic ECDH ephemerals for the outputs of a wallet's own spends.
//
//   ock  = blake2b("lelantos.note.ock.v1" || nsk_le, 32)
//   esk  = 1 + blake2b("lelantos.note.esk.v1" || ock || chainId_le || cm_le, 64)  mod (q - 1)
//
// `esk` is recomputable from the seed and the commitment the pool publishes with the output.
// Revealing it for one output proves that payment to a third party: `esk · B` is the output's
// published `epk`, and `esk · pk_d` opens its ciphertext for the address it was sent to. See
// `wallet/ops/payment-proof.ts`. Without `ock` it is as unpredictable as a random scalar.
//
// `encryptNote` keys the cipher on `epk` and derives its nonce from `epk` alone, so one `esk`
// must never encrypt two plaintexts. That holds by construction: `cm` fixes the note's asset,
// value, owner, `rho` and `rcm`, which include every field of the plaintext.

import { blake2b } from "@noble/hashes/blake2";
import { FIELD_BYTES, fromLeBytes, toLeBytes } from "../core/bytes.js";
import { BABYJUB_SUBGROUP_ORDER } from "../core/field.js";
import type { Field } from "../crypto/poseidon.js";

const OCK_DOMAIN = new TextEncoder().encode("lelantos.note.ock.v1");
const ESK_DOMAIN = new TextEncoder().encode("lelantos.note.esk.v1");

/**
 * The outgoing cipher key of the account `nsk` roots: the secret every output ephemeral of its
 * spends derives from.
 *
 * As sensitive as a viewing key for what the account sent: with a payee's address, its holder
 * can open that payee's notes from this account. It grants no spend authority and reveals
 * nothing about incoming notes.
 *
 * @internal
 */
export function deriveOutgoingKey(nsk: Field): Uint8Array {
    const h = blake2b.create({ dkLen: 32 });
    h.update(OCK_DOMAIN);
    h.update(toLeBytes(nsk));
    return h.digest();
}

/**
 * The ECDH ephemeral for the output committed as `cm`.
 *
 * Uniform in `[1, q - 1]` up to a ~2^-260 bias from the 512-bit reduction.
 *
 * @internal
 */
export function deriveOutputEsk(ock: Uint8Array, chainId: bigint, cm: Field): Field {
    const h = blake2b.create({ dkLen: 64 });
    h.update(ESK_DOMAIN);
    h.update(ock);
    h.update(toLeBytes(chainId, FIELD_BYTES));
    h.update(toLeBytes(cm));
    return (fromLeBytes(h.digest()) % (BABYJUB_SUBGROUP_ORDER - 1n)) + 1n;
}
