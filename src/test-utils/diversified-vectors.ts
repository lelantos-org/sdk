// Builds `tests/vectors/diversified.json`: the cross-language vectors for diversified addresses.
//
// `scripts/gen-diversified-vectors.ts` writes the file and `src/diversified-vectors.test.ts`
// asserts the committed copy equals a fresh build. A second implementation is correct when it
// reproduces every value from the inputs in the file.
//
// Encodings. Every field name ends in its encoding:
//
//   *_dec          unsigned integer as a decimal string
//   *_hex          bytes in wire order, byte 0 first, 0x-prefixed
//   *_le32_hex     the integer as 32 little-endian bytes
//   *_packed_hex   a Baby-Jubjub point as 32 bytes: y little-endian, with bit 7 of byte 31 set
//                  iff x > (p - 1) / 2 (circomlibjs `packPoint`)
//   *_bits_hex     ceil(gamma / 8) bytes; bit i is bit (i & 7) of byte (i >> 3)
//
// Points are also given as `{ x_dec, y_dec }`. The same conventions are repeated in the file's
// `encoding` block.
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

import { toLeBytes } from "../core/bytes.js";
import { BABYJUB_SUBGROUP_ORDER, BN254_FR, POW_2_64 } from "../core/field.js";
import { bytesToHex } from "../core/hex.js";
import { deriveDk, deriveIvk } from "../crypto/derive.js";
import { DIVERSIFIER_BOUND, findDiversifiedBase } from "../crypto/diversified-base.js";
import type { Jubjub, Point } from "../crypto/jubjub.js";
import type { Poseidon } from "../crypto/poseidon.js";
import { TAG_DK, TAG_FMD_BIT, TAG_FMD_EXPAND2, TAG_GD, TAG_IVK, TAG_PK } from "../crypto/tags.js";
import { fmdFlagOnBase, fmdTest } from "../fmd/clue.js";
import {
    fmdDiversifiedDetectionKey,
    fmdDiversifiedFlagKey,
    fmdExpandScalar2,
    fmdExpectedClue,
} from "../fmd/diversified.js";
import { FMD_DEFAULT_GAMMA } from "../fmd/keys.js";
import { buildDiversifiedKeys, deriveDkRoot } from "../keys/diversified.js";
import {
    deriveDiversifierKey,
    diversifierAt,
    diversifierIndex,
    diversifierToField,
} from "../keys/diversifier.js";
import { deriveDepositRho, deriveOutputSecret, expandSeed, seedFromSecret } from "../notes/seed.js";
import { lcgScalars } from "./lcg.js";

/** Number of `h_i` the file tabulates. */
const H_TABLE_SIZE = 14;

/** Diversifier indices every account has an address at. */
const INDICES = [0, 1, 0x0102_0304, 2 ** 32 - 1];

/** How many of those addresses, from the first, get a clue. */
const CLUE_ADDRESSES = 2;

const dec = (x: bigint) => x.toString();
const point = (p: Point) => ({ x_dec: dec(p[0]), y_dec: dec(p[1]) });
const concat = (parts: Uint8Array[]) => new Uint8Array(parts.flatMap((p) => [...p]));

function check(condition: boolean, message: string): asserts condition {
    if (!condition) throw new Error(`diversified vectors: ${message}`);
}

/** The vector file as a plain object. A pure function of the fixed inputs above. */
export function buildDiversifiedVectors(J: Jubjub, P: Poseidon) {
    const pack = (p: Point) => bytesToHex(J.packPoint(p));

    // Every account with its addresses at `INDICES`.
    const accounts = [7n, deriveIvk(P, 1n), deriveIvk(P, 42n)].map((ivk, k) => {
        const dvk = deriveDiversifierKey(ivk);
        const dkRoot = deriveDkRoot(P, ivk);
        const owned = INDICES.map((index) => {
            const dBytes = diversifierAt(dvk, index);
            const d = diversifierToField(dBytes);
            check(diversifierIndex(dvk, dBytes) === index, "diversifier does not round-trip");
            return {
                label: `ivk[${k}] index=${index}`,
                ivk,
                dvk,
                dkRoot,
                index,
                dBytes,
                d,
                keys: buildDiversifiedKeys(P, J, ivk, d),
            };
        });
        return { ivk, dkRoot, owned };
    });
    const owned = accounts.flatMap((account) => account.owned);

    const addresses = owned.map(({ label, ivk, dvk, dkRoot, index, dBytes, d, keys }) => {
        const plaintext = new Uint8Array(16);
        new DataView(plaintext.buffer).setUint32(0, index, true);
        return {
            label,
            ivk_dec: dec(ivk),
            ivk_le32_hex: bytesToHex(toLeBytes(ivk)),
            index,
            dvk_hex: bytesToHex(dvk),
            aes_plaintext_hex: bytesToHex(plaintext),
            d_bytes_hex: bytesToHex(dBytes),
            d_dec: dec(d),
            g_d_ctr: findDiversifiedBase(J, P, d).ctr,
            g_d: point(keys.g_d),
            g_d_packed_hex: pack(keys.g_d),
            pk_dec: dec(keys.pk),
            pk_d: point(keys.pk_d),
            pk_d_packed_hex: pack(keys.pk_d),
            dk_root_dec: dec(dkRoot),
            ck_d: point(keys.ck_d),
            ck_d_packed_hex: pack(keys.ck_d),
        };
    });
    check(
        addresses.some((a) => a.g_d_ctr === 0) && addresses.some((a) => a.g_d_ctr > 0),
        "addresses must cover both a counter of 0 and a later one",
    );

    // g_d, with every candidate up to the one used.
    const bases = [0n, 1n, 7n, DIVERSIFIER_BOUND - 1n].map((d) => {
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
        return { d_dec: dec(d), candidates, ctr, g_d: point(g_d), g_d_packed_hex: pack(g_d) };
    });

    const h = Array.from({ length: H_TABLE_SIZE }, (_, i) => fmdExpandScalar2(P, i));
    const detection = accounts.flatMap(({ ivk, dkRoot }) =>
        [FMD_DEFAULT_GAMMA, H_TABLE_SIZE].map((gamma) => ({
            ivk_dec: dec(ivk),
            dk_dec: dec(deriveDk(P, ivk)),
            dk_root_dec: dec(dkRoot),
            gamma,
            x_dec: fmdDiversifiedDetectionKey(P, dkRoot, gamma).x.map(dec),
        })),
    );

    const rng = lcgScalars(0xd1ce5n);
    const clues = accounts.flatMap((account, k) => {
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
                bytesToHex(expected.R) === bytesToHex(clue.R) &&
                    bytesToHex(expected.bits) === bytesToHex(clue.bits),
                "recipient recomputation disagrees with the sender's clue",
            );
            const detectSelf = fmdTest(J, P, own, clue);
            check(detectSelf, "own detection key rejects the clue");
            return {
                label,
                ivk_dec: dec(ivk),
                index,
                d_bytes_hex: bytesToHex(dBytes),
                g_d_packed_hex: pack(g_d),
                ck_d_packed_hex: pack(ck_d),
                gamma: clue.gamma,
                flag_key_packed_hex: fk.X.map(pack),
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

    const patternedKey = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);
    const seedInputs = [
        {
            ock: Uint8Array.from({ length: 32 }, (_, i) => i),
            chainId: 1n,
            rho: 99n,
            asset: 0n,
            value: 0n,
            address: 0,
        },
        {
            ock: new Uint8Array(32).fill(0xff),
            chainId: 8453n,
            rho: BN254_FR - 1n,
            asset: POW_2_64 - 1n,
            value: POW_2_64 - 1n,
            address: 3,
        },
        {
            ock: patternedKey,
            chainId: POW_2_64 + 5n,
            rho: P.hash([TAG_IVK, 0xabcdefn]),
            asset: 1n,
            value: 10n ** 18n,
            address: 5,
        },
    ];
    const seeds = seedInputs.map(({ ock, chainId, rho, asset, value, address }) => {
        const { dkRoot, dBytes, d, keys } = owned[address]!;
        const { pk, g_d } = keys;
        const osk = deriveOutputSecret(ock, { chainId, rho, asset, value, d: dBytes, pk });
        const rseed = seedFromSecret(osk);
        const { rcm, esk, fmdR } = expandSeed(rseed, rho);
        const epk = J.mulPointEscalar(g_d, esk);
        const clue = fmdExpectedClue(J, P, dkRoot, d, fmdR);
        return {
            address_index: address,
            ock_hex: bytesToHex(ock),
            chain_id_dec: dec(chainId),
            rho_dec: dec(rho),
            asset_dec: dec(asset),
            value_dec: dec(value),
            d_bytes_hex: bytesToHex(dBytes),
            pk_dec: dec(pk),
            osk_preimage_hex: bytesToHex(
                concat([
                    new TextEncoder().encode("lelantos.note.osk.v2"),
                    ock,
                    toLeBytes(chainId, 32),
                    toLeBytes(rho, 32),
                    toLeBytes(asset, 8),
                    toLeBytes(value, 8),
                    dBytes,
                    toLeBytes(pk, 32),
                ]),
            ),
            osk_hex: bytesToHex(osk),
            rseed_hex: bytesToHex(rseed),
            rcm_dec: dec(rcm),
            esk_dec: dec(esk),
            fmd_r_dec: dec(fmdR),
            // esk · g_d, and the clue flagged with fmdR for the address at `address_index`.
            epk_packed_hex: pack(epk),
            gamma: clue.gamma,
            clue_R_packed_hex: bytesToHex(clue.R),
            clue_bits_hex: bytesToHex(clue.bits),
        };
    });

    const depositRho = [
        {
            ock: Uint8Array.from({ length: 32 }, (_, i) => i),
            nonce: Uint8Array.from({ length: 32 }, (_, i) => 0xa0 + i),
        },
        { ock: patternedKey, nonce: new Uint8Array(32) },
    ].map(({ ock, nonce }) => ({
        ock_hex: bytesToHex(ock),
        nonce_hex: bytesToHex(nonce),
        rho_dec: dec(deriveDepositRho(ock, nonce)),
    }));

    return {
        version: 1,
        curve: "babyjubjub",
        hash: "poseidon",
        encoding: {
            _dec: "unsigned integer, decimal string",
            _hex: "bytes in wire order (byte 0 first), 0x-prefixed",
            _le32_hex: "the integer as 32 little-endian bytes",
            _packed_hex:
                "point as 32 bytes: y little-endian, bit 7 of byte 31 set iff x > (p - 1) / 2",
            _bits_hex: "ceil(gamma / 8) bytes; bit i is bit (i & 7) of byte (i >> 3)",
            d: "d_dec is d_bytes_hex read little-endian",
            aes: "AES-128, one raw block (ECB, no padding), key dvk",
        },
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
        domains: {
            dvk: "lelantos.addr.dvk.v1",
            osk: "lelantos.note.osk.v2",
            rseed: "lelantos.note.rseed.v2",
            rcm: "lelantos.note.rcm.v2",
            esk: "lelantos.note.esk.v2",
            fmd_r: "lelantos.note.fmdr.v2",
            deposit_rho: "lelantos.note.rho.v2",
        },
        addresses,
        diversified_base: bases,
        fmd: { h_dec: h.map(dec), detection, clues },
        seed: seeds,
        deposit_rho: depositRho,
    };
}

/** The exact bytes of the committed file. */
export function serializeDiversifiedVectors(vectors: unknown): string {
    return `${JSON.stringify(vectors, null, 2)}\n`;
}
