// ZIP-32-lite hierarchical key derivation for Baby-Jubjub.
//
// One BIP39 seed → many independent `nsk` roots (accounts). Each account's
// nsk feeds the existing `buildSpendingKey` pipeline (sdk/src/keys.ts) to
// produce its own ivk/nk/pk_d/dk/pk subtree.
//
// Path: m / 32' / LELANTOS_COIN_TYPE' / account'  — hardened-only.
//
// Quick start:
//   const esk = mnemonicToAccountKey(mnemonic, 0);
//   const nsk = esk.nsk;                          // pass to buildSpendingKey
//   accountPath(0) === "m/32'/1819239265'/0'";    // for logging/display
//
// PRF: blake2b in keyed mode with the parent chain code as the key. Domain
// byte 0x11 is reserved for hardened sk-derivation; 0x12 is left free for
// future non-hardened ivk-derivation if/when ZIP-32 full mode is added.

import { blake2b } from "@noble/hashes/blake2";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { BN254_FR, type Field, fromLeBytes, toLeBytes } from "../crypto/index.js";

const HARDENED_BIT = 0x80000000;
const MAX_INDEX = HARDENED_BIT; // exclusive upper bound for user-facing index

const MASTER_PERSONAL = new TextEncoder().encode("Lelantos_ZIP32_v1_Master");

/// ZIP-32 purpose; matches Sapling/Orchard convention.
export const ZIP32_PURPOSE = 32;

/// Unregistered Lelantos coin type — placeholder ASCII "lela" big-endian.
export const LELANTOS_COIN_TYPE = 0x6c656c61;

export interface ExtendedSpendingKey {
    nsk: Field;
    chainCode: Uint8Array;
    depth: number;
    /// Raw on-the-wire child index (hardened bit included for hardened
    /// children). User-facing account number is `childIndex & 0x7fffffff`.
    childIndex: number;
}

function reduceNsk(b: Uint8Array): Field {
    const v = fromLeBytes(b) % BN254_FR;
    return v === 0n ? 1n : v;
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
        throw new Error(`${label} must be integer in [0, 2^31); got ${i}`);
    }
}

/// Master ESK from a 64-byte BIP39 seed.
export function masterFromSeed(seed: Uint8Array): ExtendedSpendingKey {
    const I = blake2b(seed, { dkLen: 64, key: MASTER_PERSONAL });
    return {
        nsk: reduceNsk(I.slice(0, 32)),
        chainCode: I.slice(32, 64),
        depth: 0,
        childIndex: 0,
    };
}

/// Hardened child derivation. Pass the user-facing index (e.g. `32` for
/// purpose, `0` for first account); the hardened bit is applied internally.
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
    const I = blake2b(data, { dkLen: 64, key: parent.chainCode });
    return {
        nsk: reduceNsk(I.slice(0, 32)),
        chainCode: I.slice(32, 64),
        depth: parent.depth + 1,
        childIndex: wireIndex,
    };
}

/// Walk the canonical Lelantos path from a BIP39 seed:
/// `m / 32' / LELANTOS_COIN_TYPE' / account'`.
export function deriveAccount(seed: Uint8Array, account: number): ExtendedSpendingKey {
    checkIndex(account, "account");
    const master = masterFromSeed(seed);
    const purpose = deriveChildHardened(master, ZIP32_PURPOSE);
    const coin = deriveChildHardened(purpose, LELANTOS_COIN_TYPE);
    return deriveChildHardened(coin, account);
}

/// One-shot mnemonic → account ESK. Validates BIP39, derives the canonical
/// path. Use `.nsk` from the result with `buildSpendingKey` (or call the
/// higher-level `deriveKeysFromMnemonic`).
export function mnemonicToAccountKey(
    mnemonic: string,
    account = 0,
    passphrase = "",
): ExtendedSpendingKey {
    if (!validateMnemonic(mnemonic, wordlist)) {
        throw new Error("invalid BIP39 mnemonic");
    }
    return deriveAccount(mnemonicToSeedSync(mnemonic, passphrase), account);
}

/// Render the canonical derivation path for an account as a string. Useful
/// for logs, debug output, and HW-wallet integrations.
export function accountPath(account: number): string {
    checkIndex(account, "account");
    return `m/${ZIP32_PURPOSE}'/${LELANTOS_COIN_TYPE}'/${account}'`;
}
