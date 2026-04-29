// Key-source resolver: turns mnemonic / EIP-712 signature / raw nsk into
// an `nsk` field element. All three forms produce a deterministic Field;
// callers persist the *source* (mnemonic phrase or signature hex), never
// the derived nsk.
//
// Mnemonic: BIP39 seed → blake2b("lelantos.nsk.v1" || seed) → mod BN254_FR.
// Signature: keccak256 of the EIP-712 sig → mod BABYJUB_SUBGROUP_ORDER
//   (delegates to the existing `metamask.reduceSignatureToScalar`).
// Raw nsk: trust the caller; assumes already in-range.

import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { blake2b } from "@noble/hashes/blake2";
import { BN254_FR, fromLeBytes, type Field } from "../crypto/index";
import * as metamask from "../metamask";

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

/// Generate a fresh BIP39 mnemonic. Strength 128 → 12 words, 256 → 24.
export function generateNewMnemonic(strength: 128 | 256 = 256): string {
    return generateMnemonic(wordlist, strength);
}

export function isValidMnemonic(mnemonic: string): boolean {
    return validateMnemonic(mnemonic, wordlist);
}
