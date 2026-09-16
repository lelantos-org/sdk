// ZIP-32-lite hierarchical key derivation for Baby-Jubjub.
//
// Path: m / 32' / LELANTOS_COIN_TYPE' / account' (hardened-only).
// PRF: blake2b keyed with the parent chain code. Domain byte 0x11 is reserved for hardened
// sk-derivation; 0x12 is reserved for future non-hardened ivk-derivation.
//
// `nsk` is drawn from 40 bytes, leaving 66 spare bits over BN254 Fr (see `reduceWideToField`).
// Drawing 32 bytes, 2 bits wider than Fr, would skew the low residues by about 6:5.
//
// The 40-byte `nsk` and 32-byte chain code need 72 bytes and blake2b caps output at 64, so each
// PRF block is two keyed calls under the same key, separated by a leading domain byte. The
// personalisation string carries the version ("v1"), so trees from different versions cannot be
// confused.

import { blake2b } from "@noble/hashes/blake2";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { toLeBytes } from "../core/bytes.js";
import { BN254_FR, reduceWideToField } from "../core/field.js";
import type { Field } from "../crypto/poseidon.js";
import { InvalidArgumentError } from "../errors/config.js";

const HARDENED_BIT = 0x80000000;
/** Exclusive upper bound for user-facing index. */
const MAX_INDEX = HARDENED_BIT;

const MASTER_PERSONAL = new TextEncoder().encode("Lelantos_ZIP32_v1_Master");

/**
 * PRF draw widths.
 *
 * `NSK_BYTES` is 40 so the reduction into BN254 Fr keeps 66 spare bits. `reduceWideToField`
 * throws if it is narrowed enough to introduce bias.
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
 * Two calls because blake2b output is capped at 64 bytes and the two halves need 72.
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
    data.set(toLeBytes(BigInt(wireIndex), 4), 1);
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
        // The mnemonic is omitted: it is the root secret, and error messages reach logs verbatim.
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
