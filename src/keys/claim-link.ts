// Spending keys for claim links, derived from the sender's own.
//
// A claim link is a bearer key: the sender funds a fresh account and hands its `nsk` over in a
// URL. The key derives from the sender's `nsk` and an index, so every link the account made can
// be recomputed from the seed and an unclaimed one swept back.
//
//   nsk_i = keccakExpand(tag || nsk_le || chainId_le || u32le(i), 2) mod q
//
// Recovering `nsk` from `nsk_i` means inverting keccak, so distinct indices are unlinkable to
// each other and to the sender, and a payee holding `nsk_i` learns nothing about `nsk_j`.
//
// An index must fund at most one link: two links made from one index share a key, so whoever
// holds the first can take the second. The caller picks the first index whose account has never
// held a note, read from the chain; a counter kept in one browser is unknown to the next.

import { toLeBytes } from "../core/bytes.js";
import { assertNonZeroField, BABYJUB_SUBGROUP_ORDER, reduceWideToField } from "../core/field.js";
import { keccakExpand } from "../crypto/keccak.js";
import type { Field } from "../crypto/poseidon.js";
import { InvalidArgumentError } from "../errors/config.js";

/** Changing it changes every link key an account derives, stranding funds in unclaimed links. */
const CLAIM_LINK_DOMAIN_TAG = new TextEncoder().encode("lelantos.claim-link.nsk.v1\0");

/** Exclusive upper bound for `index`, matching the ZIP-32 account bound. */
const MAX_INDEX = 0x80000000;

/**
 * The spending key of the account's `index`-th claim link on chain `chainId`.
 *
 * As sensitive as the funds sent to it: this is the secret the link carries.
 *
 * @param nsk The sender's nullifier spending key.
 * @throws {InvalidArgumentError} for an `index` outside `[0, 2^31)`.
 */
export function deriveClaimLinkNsk(nsk: Field, chainId: bigint, index: number): Field {
    assertNonZeroField(nsk, "nsk");
    if (!Number.isInteger(index) || index < 0 || index >= MAX_INDEX) {
        throw new InvalidArgumentError(
            `claim-link index must be an integer in [0, 2^31); got ${index}`,
            { argument: "index" },
        );
    }
    const tag = CLAIM_LINK_DOMAIN_TAG;
    const preimage = new Uint8Array(tag.length + 32 + 32 + 4);
    preimage.set(tag, 0);
    preimage.set(toLeBytes(nsk), tag.length);
    preimage.set(toLeBytes(chainId, 32), tag.length + 32);
    preimage.set(toLeBytes(BigInt(index), 4), tag.length + 64);
    // Two keccak blocks: see `reduceWideToField` on folding a bare digest.
    return reduceWideToField(keccakExpand(preimage, 2), BABYJUB_SUBGROUP_ORDER, "nsk");
}
