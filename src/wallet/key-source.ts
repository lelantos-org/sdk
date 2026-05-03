// Key-source resolver: turns mnemonic / EIP-712 signature / raw nsk into
// an `nsk` field element. All three forms produce a deterministic Field;
// callers persist the *source* (mnemonic phrase or signature hex), never
// the derived nsk.
//
// Mnemonic: BIP39 seed → blake2b("lelantos.nsk.v1" || seed) → mod BN254_FR.
// Signature: keccak256 of the EIP-712 sig → mod BABYJUB_SUBGROUP_ORDER
//   (delegates to the existing `metamask.reduceSignatureToScalar`).
// Raw nsk: trust the caller; assumes already in-range.

import { blake2b } from "@noble/hashes/blake2";
import {
    generateMnemonic as bip39GenerateMnemonic,
    mnemonicToSeedSync,
    validateMnemonic,
} from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { BN254_FR, type Field, fromLeBytes } from "../crypto/index.js";
import * as metamask from "../metamask.js";

const NSK_DOMAIN = new TextEncoder().encode("lelantos.nsk.v1");

export type KeySource =
    | { type: "mnemonic"; mnemonic: string; passphrase?: string }
    | { type: "signature"; signature: string }
    | { type: "nsk"; nsk: Field };

/// Mnemonic → 64-byte BIP39 seed → blake2b("lelantos.nsk.v1" || seed) →
/// reduce mod BN254_FR. Domain-separated so the same mnemonic could later
/// derive orthogonal keys without colliding.
export function mnemonicToNsk(mnemonic: string, passphrase = ""): Field {
    if (!validateMnemonic(mnemonic, wordlist)) {
        throw new Error("invalid BIP39 mnemonic");
    }
    const seed = mnemonicToSeedSync(mnemonic, passphrase);
    const h = blake2b.create({ dkLen: 64 });
    h.update(NSK_DOMAIN);
    h.update(seed);
    const wide = fromLeBytes(h.digest());
    const nsk = wide % BN254_FR;
    return nsk === 0n ? 1n : nsk;
}

export function resolveNsk(source: KeySource): Field {
    switch (source.type) {
        case "mnemonic":
            return mnemonicToNsk(source.mnemonic, source.passphrase);
        case "signature":
            if (!/^0x[0-9a-fA-F]+$/.test(source.signature)) {
                throw new Error("signature must be 0x-hex");
            }
            return metamask.reduceSignatureToScalar(source.signature);
        case "nsk":
            return source.nsk;
    }
}

/// Generate a fresh BIP39 mnemonic. Pass `{ words: 24 }` (default) for
/// 256-bit entropy, or `{ words: 12 }` for 128-bit. Strings count, not bits.
export function generateMnemonic(opts: { words?: 12 | 24 } = {}): string {
    const strength = (opts.words ?? 24) === 12 ? 128 : 256;
    return bip39GenerateMnemonic(wordlist, strength);
}

/// @deprecated Use `generateMnemonic({ words: 12 | 24 })` — argument was
/// entropy bits which is easy to confuse with word count. Kept for
/// back-compat; will be removed in a future major.
export function generateNewMnemonic(strength: 128 | 256 = 256): string {
    return bip39GenerateMnemonic(wordlist, strength);
}

export function isValidMnemonic(mnemonic: string): boolean {
    return validateMnemonic(mnemonic, wordlist);
}
