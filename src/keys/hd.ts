// ZIP-32-lite hierarchical key derivation for Baby-Jubjub.
//
// Path: m / 32' / LELANTOS_COIN_TYPE' / account' (hardened-only).
// PRF: blake2b keyed with parent chain code. Domain byte 0x11 is reserved
// for hardened sk-derivation; 0x12 is reserved for future non-hardened
// ivk-derivation.
//
// v2 changed how a PRF block is drawn. v1 took `nsk` from the first 32 bytes
// of one 64-byte blake2b output, which is 2 bits wider than BN254 Fr, so
// reducing it skewed the low residues by about 6:5. `nsk` now comes off 40
// bytes — 66 spare bits, see `reduceWideToField`.
//
// That needs 72 bytes and blake2b caps output at 64, so the two halves are two
// keyed calls under the same key, separated by a leading domain byte, rather
// than one wider call. The chain code keeps its full 32 bytes. The
// personalisation string carries the version, so a v1 and a v2 tree cannot be
// confused; every v1-derived key is invalidated.

import { blake2b } from "@noble/hashes/blake2";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { InvalidArgumentError } from "../core/errors.js";
import { BN254_FR, reduceWideToField } from "../core/field.js";
import { toLeBytes } from "../crypto/bytes.js";
import type { Field } from "../crypto/poseidon.js";

const HARDENED_BIT = 0x80000000;
/** Exclusive upper bound for user-facing index. */
const MAX_INDEX = HARDENED_BIT;

const MASTER_PERSONAL = new TextEncoder().encode("Lelantos_ZIP32_v2_Master");

/**
 * PRF draw widths.
 *
 * `NSK_BYTES` is 40 rather than 32 so the reduction into BN254 Fr keeps 66
 * spare bits. Narrowing it reintroduces the v1 bias, so `reduceWideToField`
 * throws rather than letting that happen quietly.
 */
const NSK_BYTES = 40;
const CHAIN_CODE_BYTES = 32;

/** Leading domain byte separating the two halves of a PRF block. */
const PRF_NSK = 0x00;
const PRF_CHAIN_CODE = 0x01;

/**
 * Matches Sapling/Orchard convention.
 *
 * @internal
 */
export const ZIP32_PURPOSE = 32;

/**
 * Unregistered placeholder; ASCII "lela" big-endian.
 *
 * @internal
 */
export const LELANTOS_COIN_TYPE = 0x6c656c61;

/** @internal */
export interface ExtendedSpendingKey {
    nsk: Field;
    chainCode: Uint8Array;
    depth: number;
    /** Wire index with hardened bit. User-facing account = `childIndex & 0x7fffffff`. */
    childIndex: number;
}

/**
 * One PRF block: `nsk` and the next chain code, keyed by `key` over `data`.
 *
 * Two calls rather than one wide one because blake2b maxes out at 64 bytes and
 * the two halves need 72 between them.
 */
function prf(key: Uint8Array, data: Uint8Array): { nsk: Field; chainCode: Uint8Array } {
    const tagged = (tag: number, dkLen: number): Uint8Array => {
        const buf = new Uint8Array(1 + data.length);
        buf[0] = tag;
        buf.set(data, 1);
        return blake2b(buf, { dkLen, key });
    };
    return {
        nsk: reduceWideToField(tagged(PRF_NSK, NSK_BYTES), BN254_FR, "nsk"),
        chainCode: tagged(PRF_CHAIN_CODE, CHAIN_CODE_BYTES),
    };
}

function u32LE(n: number): Uint8Array {
    const out = new Uint8Array(4);
    out[0] = n & 0xff;
    out[1] = (n >>> 8) & 0xff;
    out[2] = (n >>> 16) & 0xff;
    out[3] = (n >>> 24) & 0xff;
    return out;
}

function checkIndex(i: number, label: string): void {
    if (!Number.isInteger(i) || i < 0 || i >= MAX_INDEX) {
        throw new InvalidArgumentError(`${label} must be an integer in [0, 2^31); got ${i}`, {
            argument: label,
        });
    }
}

/**
 * From a 64-byte BIP39 seed.
 *
 * @internal
 */
export function masterFromSeed(seed: Uint8Array): ExtendedSpendingKey {
    return {
        ...prf(MASTER_PERSONAL, seed),
        depth: 0,
        childIndex: 0,
    };
}

/**
 * Pass user-facing index; hardened bit is applied internally.
 *
 * @internal
 */
export function deriveChildHardened(
    parent: ExtendedSpendingKey,
    index: number,
): ExtendedSpendingKey {
    checkIndex(index, "child index");
    const wireIndex = (index | HARDENED_BIT) >>> 0;
    const nskBytes = toLeBytes(parent.nsk);
    const data = new Uint8Array(1 + 4 + 32);
    data[0] = 0x11;
    data.set(u32LE(wireIndex), 1);
    data.set(nskBytes, 5);
    return {
        ...prf(parent.chainCode, data),
        depth: parent.depth + 1,
        childIndex: wireIndex,
    };
}

/**
 * `m / 32' / LELANTOS_COIN_TYPE' / account'`.
 *
 * @internal
 */
export function deriveAccount(seed: Uint8Array, account: number): ExtendedSpendingKey {
    checkIndex(account, "account");
    const master = masterFromSeed(seed);
    const purpose = deriveChildHardened(master, ZIP32_PURPOSE);
    const coin = deriveChildHardened(purpose, LELANTOS_COIN_TYPE);
    return deriveChildHardened(coin, account);
}

/**
 * Validates BIP39, derives the canonical path.
 *
 * @internal
 */
export function mnemonicToAccountKey(
    mnemonic: string,
    account = 0,
    passphrase = "",
): ExtendedSpendingKey {
    if (!validateMnemonic(mnemonic, wordlist)) {
        // The mnemonic itself is left out: it is the wallet's root secret, and
        // a message reaches application logs verbatim.
        throw new InvalidArgumentError("invalid BIP39 mnemonic", { argument: "mnemonic" });
    }
    return deriveAccount(mnemonicToSeedSync(mnemonic, passphrase), account);
}

/**
 * Render the canonical derivation path string.
 *
 * @internal
 */
export function accountPath(account: number): string {
    checkIndex(account, "account");
    return `m/${ZIP32_PURPOSE}'/${LELANTOS_COIN_TYPE}'/${account}'`;
}
