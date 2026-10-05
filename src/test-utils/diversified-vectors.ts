// Builds `tests/vectors/diversified.json`: the cross-language vectors for diversified addresses.
//
// `scripts/gen-diversified-vectors.ts` writes the file and `src/diversified-vectors.test.ts`
// asserts the committed copy equals a fresh build. A second implementation is correct when it
// reproduces every value from the inputs in the file.
//
// Encodings. Every field name ends in its encoding (`_dec`, `_hex`, `_le32_hex`, `_packed_hex`,
// `_bits_hex`, `_bech32`); `ENCODING` below defines each and is emitted as the file's `encoding`
// block. `_packed_hex` is circomlibjs `packPoint`. Points are also given as `{ x_dec, y_dec }`.
//
// Derivations, with `LEn(x)` the integer `x` as `n` little-endian bytes, `q` the Baby-Jubjub
// subgroup order, `r` the BN254 scalar field modulus and `P` Poseidon over that field:
//
//   dvk      = blake2b-128( "lelantos.addr.dvk.v1" || LE32(ivk) )
//   d_bytes  = AES-128-encrypt_dvk( LE4(index) || 0^12 )           one raw block, no padding
//   d        = d_bytes read little-endian
//   g_d      = [8]·unpack(LE32(P(TAG_GD, d, ctr))), first ctr in 0..255 that decodes to a point
//              with [8]·point ≠ identity
//   pk       = P(TAG_PK, ivk, d)
//   pk_d     = (ivk mod q)·g_d
//   dk_root  = P(TAG_DK, ivk) mod q
//   ck_d     = dk_root·g_d
//   h_i      = P(TAG_FMD_EXPAND2, i) mod q
//   x_i      = dk_root + h_i mod q
//   X_i      = ck_d + h_i·g_d
//   clue     = ( R = r·g_d, c_i = legendre_bit(P(TAG_FMD_BIT, R.x, R.y, i, S_i.x, S_i.y)) xor 1 )
//              with S_i = r·X_i and legendre_bit = 1 iff the hash is a quadratic residue mod r
//   osk, rseed, rcm, esk, fmdR, depositRho: see `notes/seed.ts`; `ock` is an opaque 32-byte input
//   epk      = esk·g_d
//
// Byte layouts of the address payload (112 bytes, HRP `ADDRESS_HRP`), the `osk` preimage, the
// plaintext (96 bytes) and the wire ciphertext (114 bytes) with its key and nonce: `ENCODING`.
//
// Each `seed` entry is one output sealed by `sealOutput` to the address at `address_index`, with
// `ock` as the sender's outgoing key and `nullifiers_dec` as the nullifiers of its spend, in
// input-slot order (empty for a deposit).

import { sealOutput } from "../bundle/common.js";
import { bytesEqual, toLeBytes } from "../core/bytes.js";
import { BABYJUB_SUBGROUP_ORDER, BN254_FR, type Field, POW_2_64 } from "../core/field.js";
import { bytesToHex } from "../core/hex.js";
import { deriveDk, deriveIvk } from "../crypto/derive.js";
import {
    DIVERSIFIER_BOUND,
    DIVERSIFIER_BYTES,
    findDiversifiedBase,
} from "../crypto/diversified-base.js";
import type { Jubjub, Point } from "../crypto/jubjub.js";
import type { Poseidon } from "../crypto/poseidon.js";
import { TAG_DK, TAG_FMD_BIT, TAG_FMD_EXPAND2, TAG_GD, TAG_IVK, TAG_PK } from "../crypto/tags.js";
import { type FmdClue, fmdFlagOnBase, fmdTest } from "../fmd/clue.js";
import {
    fmdDiversifiedDetectionKey,
    fmdDiversifiedFlagKey,
    fmdExpansionScalar,
    fmdExpectedClue,
} from "../fmd/diversified.js";
import { FMD_DEFAULT_GAMMA } from "../fmd/keys.js";
import { ADDRESS_HRP, encodeAddress } from "../keys/address.js";
import { buildDiversifiedKeys, type DiversifiedKeys, deriveDkRoot } from "../keys/diversified.js";
import {
    deriveDiversifierKey,
    diversifierAt,
    diversifierIndex,
    diversifierToField,
} from "../keys/diversifier.js";
import {
    CLUE_BITS_PREFIX_BYTES,
    clueBitsToPrefix,
    encodeNotePayload,
    NOTE_CIPHERTEXT_BYTES,
    NOTE_PLAINTEXT_BYTES,
} from "../notes/codec.js";
import { decryptNote } from "../notes/encrypt.js";
import { deriveDepositRho, deriveOutputSecret, expandSeed, seedFromSecret } from "../notes/seed.js";
import { lcgScalars } from "./lcg.js";

/** Number of `h_i` the file tabulates. */
const H_TABLE_SIZE = 14;

/** Diversifier indices every account has an address at. */
const INDICES = [0, 1, 0x0102_0304, 2 ** 32 - 1];

/** How many of those addresses, from the first, get a clue. */
const CLUE_ADDRESSES = 2;

/** Diversifiers whose base is tabulated with every candidate up to the one used. */
const BASE_DIVERSIFIERS = [0n, 1n, 7n, DIVERSIFIER_BOUND - 1n];

/** Outgoing keys the `seed` and `deposit_rho` entries share. */
const COUNTING_KEY = Uint8Array.from({ length: 32 }, (_, i) => i);
const PATTERNED_KEY = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);

/** The file's `domains` block. */
const DOMAINS = {
    dvk: "lelantos.addr.dvk.v1",
    osk: "lelantos.note.osk.v2",
    rseed: "lelantos.note.rseed.v2",
    rcm: "lelantos.note.rcm.v2",
    esk: "lelantos.note.esk.v2",
    fmd_r: "lelantos.note.fmdr.v2",
    deposit_rho: "lelantos.note.rho.v2",
    kdf: "lelantos.note.kdf.v1",
    nonce: "lelantos.note.nonce.v1",
};

/** The file's `encoding` block: every suffix and byte layout, for a reader of the JSON alone. */
const ENCODING = {
    _dec: "unsigned integer, decimal string",
    _hex: "bytes in wire order (byte 0 first), 0x-prefixed",
    _le32_hex: "the integer as 32 little-endian bytes",
    _packed_hex: "point as 32 bytes: y little-endian, bit 7 of byte 31 set iff x > (p - 1) / 2",
    _bits_hex: "ceil(gamma / 8) bytes; bit i is bit (i & 7) of byte (i >> 3)",
    _bech32: "bech32m string",
    d: "d_dec is d_bytes_hex read little-endian",
    aes: "AES-128, one raw block (ECB, no padding), key dvk",
    address: "bech32m payload: d_bytes || pk_d packed || pk as 32 LE bytes || ck_d packed",
    osk_preimage:
        "osk domain || ock || chain id as 32 LE bytes || rho as 32 LE bytes || " +
        "asset as 8 LE bytes || value as 8 LE bytes || d_bytes || pk_d packed || " +
        "pk as 32 LE bytes || ck_d packed || " +
        "nullifier count as 1 byte || each nullifier as 32 LE bytes; osk is its blake2b-256",
    plaintext:
        "asset as 8 LE bytes || value as 8 LE bytes || rho as 32 LE bytes || rseed || d_bytes",
    ciphertext:
        "2 bytes, the big-endian integer whose bit i is clue bit i, then " +
        "ChaCha20-Poly1305(key, nonce, plaintext) with its 16-byte tag; " +
        "key = blake2b-256(kdf domain || epk packed || (esk * pk_d) packed), " +
        "nonce = blake2b-96(nonce domain || epk packed)",
};

/** One address of an account, with everything it derives from. */
interface OwnedAddress {
    label: string;
    ivk: Field;
    dvk: Uint8Array;
    dkRoot: Field;
    index: number;
    dBytes: Uint8Array;
    d: Field;
    keys: DiversifiedKeys;
}

interface Account {
    ivk: Field;
    dkRoot: Field;
    /** The account's address at each of `INDICES`. */
    owned: OwnedAddress[];
}

/** The inputs of one `seed` entry. `address` indexes the file's `addresses`. */
interface SeedInput {
    ock: Uint8Array;
    chainId: bigint;
    rho: Field;
    asset: bigint;
    value: bigint;
    address: number;
    nullifiers: Field[];
}

const dec = (x: bigint) => x.toString();
const point = (p: Point) => ({ x_dec: dec(p[0]), y_dec: dec(p[1]) });
const packed = (J: Jubjub, p: Point) => bytesToHex(J.packPoint(p));
const concat = (parts: Uint8Array[]) => new Uint8Array(parts.flatMap((p) => [...p]));

function check(condition: boolean, message: string): asserts condition {
    if (!condition) throw new Error(`diversified vectors: ${message}`);
}

function buildAccounts(J: Jubjub, P: Poseidon): Account[] {
    return [7n, deriveIvk(P, 1n), deriveIvk(P, 42n)].map((ivk, k) => {
        const dvk = deriveDiversifierKey(ivk);
        const dkRoot = deriveDkRoot(P, ivk);
        const owned = INDICES.map((index) => {
            const dBytes = diversifierAt(dvk, index);
            const d = diversifierToField(dBytes);
            check(diversifierIndex(dvk, dBytes) === index, "diversifier does not round-trip");
            const keys = buildDiversifiedKeys(P, J, ivk, d);
            return { label: `ivk[${k}] index=${index}`, ivk, dvk, dkRoot, index, dBytes, d, keys };
        });
        return { ivk, dkRoot, owned };
    });
}

function addressVector(J: Jubjub, P: Poseidon, address: OwnedAddress) {
    const { label, ivk, dvk, dkRoot, index, dBytes, d, keys } = address;
    return {
        label,
        ivk_dec: dec(ivk),
        ivk_le32_hex: bytesToHex(toLeBytes(ivk)),
        index,
        dvk_hex: bytesToHex(dvk),
        // LE4(index) || 0^12
        aes_plaintext_hex: bytesToHex(toLeBytes(BigInt(index), DIVERSIFIER_BYTES)),
        d_bytes_hex: bytesToHex(dBytes),
        d_dec: dec(d),
        g_d_ctr: findDiversifiedBase(J, P, d).ctr,
        g_d: point(keys.g_d),
        g_d_packed_hex: packed(J, keys.g_d),
        pk_dec: dec(keys.pk),
        pk_d: point(keys.pk_d),
        pk_d_packed_hex: packed(J, keys.pk_d),
        dk_root_dec: dec(dkRoot),
        ck_d: point(keys.ck_d),
        ck_d_packed_hex: packed(J, keys.ck_d),
        address_bech32: encodeAddress(J, keys),
    };
}

/** `g_d` for `d`, with every candidate up to the one used. */
function baseVector(J: Jubjub, P: Poseidon, d: Field) {
    const { g_d, ctr } = findDiversifiedBase(J, P, d);
    const candidates = Array.from({ length: ctr + 1 }, (_, c) => {
        const y = P.hash([TAG_GD, d, BigInt(c)]);
        const p0 = J.unpackPoint(toLeBytes(y));
        return {
            ctr: c,
            y_dec: dec(y),
            y_le32_hex: bytesToHex(toLeBytes(y)),
            decodes: p0 !== null,
            ...(p0 ? { point: point(p0) } : {}),
        };
    });
    return { d_dec: dec(d), candidates, ctr, g_d: point(g_d), g_d_packed_hex: packed(J, g_d) };
}

/** Each account's detection key at the default gamma and at the full `h` table. */
function detectionVectors(P: Poseidon, accounts: Account[]) {
    return accounts.flatMap(({ ivk, dkRoot }) =>
        [FMD_DEFAULT_GAMMA, H_TABLE_SIZE].map((gamma) => ({
            ivk_dec: dec(ivk),
            dk_dec: dec(deriveDk(P, ivk)),
            dk_root_dec: dec(dkRoot),
            gamma,
            x_dec: fmdDiversifiedDetectionKey(P, dkRoot, gamma).x.map(dec),
        })),
    );
}

/**
 * A clue for the first `CLUE_ADDRESSES` addresses of each account, tested under the account's
 * detection key and under the next account's.
 */
function clueVectors(J: Jubjub, P: Poseidon, accounts: Account[]) {
    const rng = lcgScalars(0xd1ce5n);
    return accounts.flatMap((account, k) => {
        const own = fmdDiversifiedDetectionKey(P, account.dkRoot);
        const stranger = accounts[(k + 1) % accounts.length]!;
        const other = fmdDiversifiedDetectionKey(P, stranger.dkRoot);
        const flagged = account.owned.slice(0, CLUE_ADDRESSES);
        return flagged.map(({ label, ivk, index, dBytes, d, keys: { g_d, ck_d } }) => {
            const fk = fmdDiversifiedFlagKey(J, P, ck_d, g_d);
            const r = rng();
            const clue = fmdFlagOnBase(J, P, fk, g_d, r);
            const expected = fmdExpectedClue(J, P, account.dkRoot, d, r);
            check(
                bytesEqual(expected.R, clue.R) && bytesEqual(expected.bits, clue.bits),
                "recipient recomputation disagrees with the sender's clue",
            );
            const detectSelf = fmdTest(J, P, own, clue);
            check(detectSelf, "own detection key rejects the clue");
            return {
                label,
                ivk_dec: dec(ivk),
                index,
                d_bytes_hex: bytesToHex(dBytes),
                g_d_packed_hex: packed(J, g_d),
                ck_d_packed_hex: packed(J, ck_d),
                gamma: clue.gamma,
                flag_key_packed_hex: fk.X.map((X) => packed(J, X)),
                r_dec: dec(r),
                clue_R_packed_hex: bytesToHex(clue.R),
                clue_bits_hex: bytesToHex(clue.bits),
                detect_self: detectSelf,
                other_ivk_dec: dec(stranger.ivk),
                // Pinned, not asserted false: a foreign key accepts with probability 2^-gamma.
                detect_other: fmdTest(J, P, other, clue),
            };
        });
    });
}

function seedInputs(P: Poseidon): SeedInput[] {
    return [
        {
            ock: COUNTING_KEY,
            chainId: 1n,
            rho: 99n,
            asset: 0n,
            value: 0n,
            address: 0,
            nullifiers: [],
        },
        {
            ock: new Uint8Array(32).fill(0xff),
            chainId: 8453n,
            rho: BN254_FR - 1n,
            asset: POW_2_64 - 1n,
            value: POW_2_64 - 1n,
            address: 3,
            nullifiers: [BN254_FR - 1n, 0n],
        },
        {
            ock: PATTERNED_KEY,
            chainId: POW_2_64 + 5n,
            rho: P.hash([TAG_IVK, 0xabcdefn]),
            asset: 1n,
            value: 10n ** 18n,
            address: 5,
            nullifiers: [P.hash([TAG_IVK, 1n]), P.hash([TAG_IVK, 2n])],
        },
    ];
}

/**
 * One output to `to`: the secrets its recipient recomputes from the seed, and the plaintext and
 * wire ciphertext `sealOutput` publishes for the same inputs.
 */
function seedVector(J: Jubjub, P: Poseidon, input: SeedInput, to: OwnedAddress) {
    const { ock, chainId, rho, asset, value, nullifiers } = input;
    const { dBytes, d, keys } = to;
    const { pk, g_d } = keys;
    const pkD = J.packPoint(keys.pk_d);
    const ckD = J.packPoint(keys.ck_d);

    const osk = deriveOutputSecret(ock, {
        chainId,
        rho,
        asset,
        value,
        d: dBytes,
        pk_d: pkD,
        pk,
        ck_d: ckD,
        nullifiers,
    });
    const rseed = seedFromSecret(osk);
    const { rcm, esk, fmdR } = expandSeed(rseed, rho);
    const epk = J.mulPointEscalar(g_d, esk);
    const clue = fmdExpectedClue(J, P, to.dkRoot, d, fmdR);
    const plaintext = encodeNotePayload({ asset, value, rho, rseed, d });

    const sealed = sealOutput(J, P, {
        outgoingKey: ock,
        chainId,
        rho,
        asset,
        value,
        recipient: keys,
        nullifiers,
    });
    checkSealedOutput(J, sealed, { ivk: to.ivk, rcm, epk, clue, plaintext });

    return {
        address_index: input.address,
        ock_hex: bytesToHex(ock),
        chain_id_dec: dec(chainId),
        rho_dec: dec(rho),
        asset_dec: dec(asset),
        value_dec: dec(value),
        d_bytes_hex: bytesToHex(dBytes),
        pk_d_packed_hex: bytesToHex(pkD),
        pk_dec: dec(pk),
        ck_d_packed_hex: bytesToHex(ckD),
        nullifiers_dec: nullifiers.map(dec),
        osk_preimage_hex: bytesToHex(
            concat([
                new TextEncoder().encode(DOMAINS.osk),
                ock,
                toLeBytes(chainId, 32),
                toLeBytes(rho, 32),
                toLeBytes(asset, 8),
                toLeBytes(value, 8),
                dBytes,
                pkD,
                toLeBytes(pk, 32),
                ckD,
                Uint8Array.of(nullifiers.length),
                ...nullifiers.map((nf) => toLeBytes(nf, 32)),
            ]),
        ),
        osk_hex: bytesToHex(osk),
        rseed_hex: bytesToHex(rseed),
        rcm_dec: dec(rcm),
        esk_dec: dec(esk),
        fmd_r_dec: dec(fmdR),
        // esk · g_d, and the clue flagged with fmdR for the address at `address_index`.
        epk_packed_hex: packed(J, epk),
        gamma: clue.gamma,
        clue_R_packed_hex: bytesToHex(clue.R),
        clue_bits_hex: bytesToHex(clue.bits),
        plaintext_hex: bytesToHex(plaintext),
        ciphertext_hex: bytesToHex(sealed.aux.aux.ciphertext),
    };
}

/**
 * Self-check of a `seed` entry: the output `sealOutput` publishes is the one the recipient
 * recomputes, and it opens to `plaintext` under the recipient's `ivk`.
 */
function checkSealedOutput(
    J: Jubjub,
    { note, aux }: ReturnType<typeof sealOutput>,
    recomputed: { ivk: Field; rcm: Field; epk: Point; clue: FmdClue; plaintext: Uint8Array },
): void {
    const { ivk, rcm, clue, plaintext } = recomputed;
    const epk = J.packPoint(recomputed.epk);
    const { ciphertext, ephPub, clueR } = aux.aux;
    const prefix = ciphertext.subarray(0, CLUE_BITS_PREFIX_BYTES);
    const body = ciphertext.subarray(CLUE_BITS_PREFIX_BYTES);

    check(plaintext.length === NOTE_PLAINTEXT_BYTES, "plaintext has the wrong length");
    check(ciphertext.length === NOTE_CIPHERTEXT_BYTES, "wire ciphertext has the wrong length");
    check(note.rcm === rcm, "sealed note does not commit under the seed's rcm");
    check(bytesEqual(J.packPoint(ephPub), epk), "sealed epk is not esk·g_d");
    check(
        bytesEqual(J.packPoint(clueR), clue.R) &&
            bytesEqual(prefix, clueBitsToPrefix(clue.bits, clue.gamma)),
        "sealed clue is not the one the recipient recomputes",
    );
    const opened = decryptNote({ J, ivk, note: { epk, ciphertext: body } });
    check(
        opened !== null && bytesEqual(opened, plaintext),
        "sealed ciphertext does not open to the plaintext under the recipient's ivk",
    );
}

function depositRhoVectors() {
    return [
        { ock: COUNTING_KEY, nonce: Uint8Array.from({ length: 32 }, (_, i) => 0xa0 + i) },
        { ock: PATTERNED_KEY, nonce: new Uint8Array(32) },
    ].map(({ ock, nonce }) => ({
        ock_hex: bytesToHex(ock),
        nonce_hex: bytesToHex(nonce),
        rho_dec: dec(deriveDepositRho(ock, nonce)),
    }));
}

/** The vector file as a plain object. A pure function of the fixed inputs above. */
export function buildDiversifiedVectors(J: Jubjub, P: Poseidon) {
    const accounts = buildAccounts(J, P);
    const owned = accounts.flatMap((account) => account.owned);

    const addresses = owned.map((address) => addressVector(J, P, address));
    check(
        addresses.some((a) => a.g_d_ctr === 0) && addresses.some((a) => a.g_d_ctr > 0),
        "addresses must cover both a counter of 0 and a later one",
    );

    return {
        version: 2,
        curve: "babyjubjub",
        hash: "poseidon",
        encoding: ENCODING,
        constants: {
            babyjub_subgroup_order_dec: dec(BABYJUB_SUBGROUP_ORDER),
            bn254_fr_dec: dec(BN254_FR),
        },
        tags: {
            TAG_PK: Number(TAG_PK),
            TAG_IVK: Number(TAG_IVK),
            TAG_DK: Number(TAG_DK),
            TAG_FMD_BIT: Number(TAG_FMD_BIT),
            TAG_GD: Number(TAG_GD),
            TAG_FMD_EXPAND2: Number(TAG_FMD_EXPAND2),
        },
        domains: DOMAINS,
        address_hrp: ADDRESS_HRP,
        addresses,
        diversified_base: BASE_DIVERSIFIERS.map((d) => baseVector(J, P, d)),
        fmd: {
            h_dec: Array.from({ length: H_TABLE_SIZE }, (_, i) => dec(fmdExpansionScalar(P, i))),
            detection: detectionVectors(P, accounts),
            clues: clueVectors(J, P, accounts),
        },
        seed: seedInputs(P).map((input) => seedVector(J, P, input, owned[input.address]!)),
        deposit_rho: depositRhoVectors(),
    };
}

/** The shape of `tests/vectors/diversified.json`. */
export type DiversifiedVectors = ReturnType<typeof buildDiversifiedVectors>;

/** The exact bytes of the committed file. */
export function serializeDiversifiedVectors(vectors: DiversifiedVectors): string {
    return `${JSON.stringify(vectors, null, 2)}\n`;
}
