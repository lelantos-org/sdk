// Per-output randomness derived from one 32-byte seed.
//
//   osk   = blake2b-256 of, in order:
//             "lelantos.note.osk.v3"    20 B   domain
//             ock                       32 B   sender's outgoing key
//             LE32(chainId)             32 B
//             LE32(rho)                 32 B
//             LE8(asset)                 8 B
//             LE8(value)                 8 B
//             d_bytes                   16 B   recipient's diversifier
//             pack(pk_d)                32 B   recipient's ECDH target
//             LE32(pk)                  32 B   recipient's commitment key
//             pack(ck_d)                32 B   recipient's FMD clue key
//             LE1(n)                     1 B   nullifier count
//             LE32(nullifier_i)       32·n B   for i = 0 … n-1
//             memo                     128 B   the plaintext's memo field
//   rseed = blake2b-256( "lelantos.note.rseed.v2" || osk )
//   rcm   =     LE( blake2b-512( "lelantos.note.rcm.v2"  || rseed || LE32(rho) ) ) mod BN254_FR
//   esk   = 1 + LE( blake2b-512( "lelantos.note.esk.v2"  || rseed || LE32(rho) ) ) mod (q - 1)
//   fmdR  = 1 + LE( blake2b-512( "lelantos.note.fmdr.v2" || rseed || LE32(rho) ) ) mod (q - 1)
//
//   depositRho = LE( blake2b-512( "lelantos.note.rho.v2" || ock || nonce ) ) mod BN254_FR
//
// `LEn(x)` is `x` as `n` little-endian bytes, `LE(b)` the integer `b` encodes little-endian,
// `pack(P)` the 32-byte packed encoding of a Baby-Jubjub point (`Jubjub.packPoint`), `q` the
// Baby-Jubjub subgroup order. `ock` is `deriveOutgoingKey(nsk)`.
//
// `d_bytes || pack(pk_d) || LE32(pk) || pack(ck_d)` is the recipient's 112-byte address payload
// (`keys/address.ts`), so `osk` binds the whole address: two addresses that differ in any field
// share no output randomness. The nullifiers are the public ones of the spend that made the
// output, `n` of them, none for a deposit; binding them means a rebuilt spend whose input
// nullifiers differ shares no output randomness with the earlier build. The memo is bound for the
// same reason: the encryption key and nonce follow from `esk` alone (`./encrypt.ts`), so two
// builds that differ only in their memo must not share one.
//
// The sender recomputes `osk` from `ock`, the note's fields, the recipient's address, the spend's
// nullifiers and the memo. The recipient receives `rseed` and `rho`, and `expandSeed` gives both
// sides the same `rcm`, `esk` and `fmdR`. `osk` to `rseed` is one-way, so a recipient cannot
// recover `osk`.
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
import { PACKED_POINT_BYTES } from "../crypto/jubjub-wasm/point-codec.js";
import { MEMO_BYTES } from "./codec.js";

const utf8 = (s: string) => new TextEncoder().encode(s);

const OSK_DOMAIN = utf8("lelantos.note.osk.v3");
const RSEED_DOMAIN = utf8("lelantos.note.rseed.v2");
const RCM_DOMAIN = utf8("lelantos.note.rcm.v2");
const ESK_DOMAIN = utf8("lelantos.note.esk.v2");
const FMD_R_DOMAIN = utf8("lelantos.note.fmdr.v2");
const RHO_DOMAIN = utf8("lelantos.note.rho.v2");

/** Byte width of `ock`, `osk`, `rseed` and the deposit nonce. */
const SEED_BYTES = 32;
const U64_BYTES = 8;
const WIDE_BYTES = 64;
/** Most nullifiers an output secret binds: the count is hashed as one byte. */
const MAX_NULLIFIERS = 255n;

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
 * What an output secret binds: the chain, every field of the note the output commits to, the
 * recipient's full address, the nullifiers of the spend that made it, and its memo.
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
    /** The recipient's ECDH target, packed (`Jubjub.packPoint`): 32 bytes. */
    pk_d: Uint8Array;
    /** The recipient's commitment key. */
    pk: Field;
    /** The recipient's FMD clue key, packed (`Jubjub.packPoint`): 32 bytes. */
    ck_d: Uint8Array;
    /**
     * The spend's public nullifiers, one per input slot in slot order, dummy slots included.
     * Empty for a deposit, whose `rho` comes from a fresh nonce.
     */
    nullifiers: readonly Field[];
    /** The memo field of the output's plaintext (`encodeMemo`): 128 bytes. */
    memo: Uint8Array;
}

/**
 * `osk`: the 32-byte secret the sender derives an output's seed from.
 *
 * Recomputable from `ock` and `note`, so the sender need not store it. The packed points are
 * hashed as given: whether they decode to curve points is not checked.
 *
 * @throws {InvalidArgumentError} when `ock` is not 32 bytes, `d` is not 16 bytes, `pk_d` or `ck_d`
 * is not 32 bytes, `memo` is not 128 bytes, `rho`, `pk` or a nullifier is not a canonical field
 * element, `asset` or `value` is not a uint64, `chainId` is not a uint256, or there are more than
 * 255 nullifiers.
 */
export function deriveOutputSecret(ock: Uint8Array, note: OutputSecretInputs): Uint8Array {
    assertByteLength(ock, SEED_BYTES, "ock");
    assertRange(note.chainId, 0n, 1n << 256n, "chainId", "a 256-bit unsigned integer");
    assertField(note.rho, "rho");
    assertU64(note.asset, "asset");
    assertU64(note.value, "value");
    assertByteLength(note.d, DIVERSIFIER_BYTES, "d");
    assertByteLength(note.pk_d, PACKED_POINT_BYTES, "pk_d");
    assertField(note.pk, "pk");
    assertByteLength(note.ck_d, PACKED_POINT_BYTES, "ck_d");
    assertByteLength(note.memo, MEMO_BYTES, "memo");
    const { nullifiers } = note;
    assertRange(
        BigInt(nullifiers.length),
        0n,
        MAX_NULLIFIERS + 1n,
        "nullifiers.length",
        `at most ${MAX_NULLIFIERS}`,
    );
    for (const [i, nf] of nullifiers.entries()) assertField(nf, `nullifiers[${i}]`);
    return hash(SEED_BYTES, [
        OSK_DOMAIN,
        ock,
        toLeBytes(note.chainId, FIELD_BYTES),
        toLeBytes(note.rho),
        toLeBytes(note.asset, U64_BYTES),
        toLeBytes(note.value, U64_BYTES),
        note.d,
        note.pk_d,
        toLeBytes(note.pk),
        note.ck_d,
        // The count delimits the list.
        Uint8Array.of(nullifiers.length),
        ...nullifiers.map((nf) => toLeBytes(nf)),
        note.memo,
    ]);
}

/**
 * `rseed`: the 32-byte seed carried in the note plaintext.
 *
 * @throws {InvalidArgumentError} when `osk` is not 32 bytes.
 */
export function seedFromSecret(osk: Uint8Array): Uint8Array {
    assertByteLength(osk, SEED_BYTES, "osk");
    return hash(SEED_BYTES, [RSEED_DOMAIN, osk]);
}

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
 */
export function deriveDepositRho(ock: Uint8Array, nonce: Uint8Array): Field {
    assertByteLength(ock, SEED_BYTES, "ock");
    assertByteLength(nonce, SEED_BYTES, "nonce");
    return wide([RHO_DOMAIN, ock, nonce]) % BN254_FR;
}
