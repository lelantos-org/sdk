// Per-output randomness derived from one 32-byte seed.
//
//   osk   = blake2b-256( "lelantos.note.osk.v2" || ock || LE32(chainId) || LE32(rho)
//                        || LE8(asset) || LE8(value) || d_bytes || LE32(pk) )
//   rseed = blake2b-256( "lelantos.note.rseed.v2" || osk )
//   rcm   =     LE( blake2b-512( "lelantos.note.rcm.v2"  || rseed || LE32(rho) ) ) mod BN254_FR
//   esk   = 1 + LE( blake2b-512( "lelantos.note.esk.v2"  || rseed || LE32(rho) ) ) mod (q - 1)
//   fmdR  = 1 + LE( blake2b-512( "lelantos.note.fmdr.v2" || rseed || LE32(rho) ) ) mod (q - 1)
//
//   depositRho = LE( blake2b-512( "lelantos.note.rho.v2" || ock || nonce ) ) mod BN254_FR
//
// `LEn(x)` is `x` as `n` little-endian bytes, `LE(b)` the integer `b` encodes little-endian, `q`
// the Baby-Jubjub subgroup order. `ock` is `deriveOutgoingKey(nsk)`.
//
// The sender recomputes `osk` from `ock` and the note's public and plaintext fields. The recipient
// receives `rseed` and `rho`, and `expandSeed` gives both sides the same `rcm`, `esk` and `fmdR`.
// `osk` to `rseed` is one-way, so a recipient cannot recover `osk`.
//
// `esk` and `fmdR` are in `[1, q - 1]`; `rcm` and `depositRho` are in `[0, BN254_FR)`. Each
// reduces 512 bits, so the bias is below `2^-256`.

import { blake2b } from "@noble/hashes/blake2";
import { assertByteLength, FIELD_BYTES, fromLeBytes, toLeBytes } from "../core/bytes.js";
import {
    assertField,
    assertRange,
    assertU64,
    BABYJUB_SUBGROUP_ORDER,
    BN254_FR,
    type Field,
} from "../core/field.js";
import { DIVERSIFIER_BYTES } from "../crypto/diversified-base.js";

const utf8 = (s: string) => new TextEncoder().encode(s);

const OSK_DOMAIN = utf8("lelantos.note.osk.v2");
const RSEED_DOMAIN = utf8("lelantos.note.rseed.v2");
const RCM_DOMAIN = utf8("lelantos.note.rcm.v2");
const ESK_DOMAIN = utf8("lelantos.note.esk.v2");
const FMD_R_DOMAIN = utf8("lelantos.note.fmdr.v2");
const RHO_DOMAIN = utf8("lelantos.note.rho.v2");

/** Byte width of `ock`, `osk`, `rseed` and the deposit nonce. */
const SEED_BYTES = 32;
const U64_BYTES = 8;
const WIDE_BYTES = 64;

function hash(dkLen: number, parts: Uint8Array[]): Uint8Array {
    const h = blake2b.create({ dkLen });
    for (const part of parts) h.update(part);
    return h.digest();
}

/** The 512-bit digest of `parts`, read as a little-endian integer. */
function wide(parts: Uint8Array[]): bigint {
    return fromLeBytes(hash(WIDE_BYTES, parts));
}

/**
 * What an output secret binds: the chain and every field of the note the output commits to.
 *
 * @internal
 */
export interface OutputSecretInputs {
    chainId: bigint;
    rho: Field;
    /** Asset id, a uint64. */
    asset: bigint;
    /** Note value, a uint64. */
    value: bigint;
    /** The recipient's 16 diversifier bytes. */
    d: Uint8Array;
    /** The recipient's commitment key. */
    pk: Field;
}

/**
 * `osk`: the 32-byte secret the sender derives an output's seed from.
 *
 * Recomputable from `ock` and the note, so the sender need not store it.
 *
 * @throws {InvalidArgumentError} when `ock` is not 32 bytes, `d` is not 16 bytes, `rho` or `pk`
 * is not a canonical field element, `asset` or `value` is not a uint64, or `chainId` is not a
 * uint256.
 * @internal
 */
export function deriveOutputSecret(ock: Uint8Array, note: OutputSecretInputs): Uint8Array {
    assertByteLength(ock, SEED_BYTES, "ock");
    assertRange(note.chainId, 0n, 1n << 256n, "chainId", "a 256-bit unsigned integer");
    assertField(note.rho, "rho");
    assertU64(note.asset, "asset");
    assertU64(note.value, "value");
    assertByteLength(note.d, DIVERSIFIER_BYTES, "d");
    assertField(note.pk, "pk");
    return hash(SEED_BYTES, [
        OSK_DOMAIN,
        ock,
        toLeBytes(note.chainId, FIELD_BYTES),
        toLeBytes(note.rho),
        toLeBytes(note.asset, U64_BYTES),
        toLeBytes(note.value, U64_BYTES),
        note.d,
        toLeBytes(note.pk),
    ]);
}

/**
 * `rseed`: the 32-byte seed carried in the note plaintext.
 *
 * @throws {InvalidArgumentError} when `osk` is not 32 bytes.
 * @internal
 */
export function seedFromSecret(osk: Uint8Array): Uint8Array {
    assertByteLength(osk, SEED_BYTES, "osk");
    return hash(SEED_BYTES, [RSEED_DOMAIN, osk]);
}

/** @internal */
export interface ExpandedSeed {
    /** Commitment blinder, in `[0, BN254_FR)`. */
    rcm: Field;
    /** ECDH ephemeral scalar, in `[1, q - 1]`. */
    esk: Field;
    /** FMD clue blinder, in `[1, q - 1]`. */
    fmdR: Field;
}

/**
 * The randomness of the output whose plaintext carries `rseed` and whose note has `rho`.
 *
 * @throws {InvalidArgumentError} when `rseed` is not 32 bytes or `rho` is not canonical.
 * @internal
 */
export function expandSeed(rseed: Uint8Array, rho: Field): ExpandedSeed {
    assertByteLength(rseed, SEED_BYTES, "rseed");
    assertField(rho, "rho");
    const tail = [rseed, toLeBytes(rho)];
    const scalar = (domain: Uint8Array) =>
        (wide([domain, ...tail]) % (BABYJUB_SUBGROUP_ORDER - 1n)) + 1n;
    return {
        rcm: wide([RCM_DOMAIN, ...tail]) % BN254_FR,
        esk: scalar(ESK_DOMAIN),
        fmdR: scalar(FMD_R_DOMAIN),
    };
}

/**
 * `rho` of a deposit note, from `ock` and a 32-byte nonce the caller draws at random.
 *
 * @throws {InvalidArgumentError} when `ock` or `nonce` is not 32 bytes.
 * @internal
 */
export function deriveDepositRho(ock: Uint8Array, nonce: Uint8Array): Field {
    assertByteLength(ock, SEED_BYTES, "ock");
    assertByteLength(nonce, SEED_BYTES, "nonce");
    return wide([RHO_DOMAIN, ock, nonce]) % BN254_FR;
}
