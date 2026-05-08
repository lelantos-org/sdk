// Key-source resolver: turns mnemonic / EIP-712 signature / raw nsk into
// an `nsk` field element. Callers persist the *source* (mnemonic phrase or
// signature hex), never the derived nsk.
//
// Mnemonic: BIP39 seed → ZIP-32-lite m/32'/LELANTOS_COIN_TYPE'/account'
//   (see ./hd.ts). Hierarchical: same mnemonic, different `account`, gives
//   independent nsk roots and therefore unlinkable address subtrees.
//   `account` defaults to 0; pass an explicit value for sub-accounts.
// Signature: keccak256 of the EIP-712 sig → mod BABYJUB_SUBGROUP_ORDER
//   (delegates to the existing `metamask.reduceSignatureToScalar`). Single
//   nsk only — no hierarchical expansion possible without seed material.
// Raw nsk: trust the caller; assumes already in-range.

import { generateMnemonic as bip39GenerateMnemonic, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import type { Field } from "../crypto/index.js";
import * as metamask from "../metamask.js";
import { mnemonicToAccountKey } from "./hd.js";

export type KeySource =
    | { type: "mnemonic"; mnemonic: string; account?: number; passphrase?: string }
    | { type: "signature"; signature: string }
    | { type: "nsk"; nsk: Field };

/// Mnemonic + account index → 64-byte BIP39 seed → ZIP-32-lite hardened
/// derivation at m/32'/LELANTOS_COIN_TYPE'/account' → nsk field element.
/// `account` defaults to 0.
export function mnemonicToNsk(mnemonic: string, account = 0, passphrase = ""): Field {
    return mnemonicToAccountKey(mnemonic, account, passphrase).nsk;
}

export function resolveNsk(source: KeySource): Field {
    switch (source.type) {
        case "mnemonic":
            return mnemonicToNsk(source.mnemonic, source.account ?? 0, source.passphrase);
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
/// 256-bit entropy, or `{ words: 12 }` for 128-bit.
export function generateMnemonic(opts: { words?: 12 | 24 } = {}): string {
    const strength = (opts.words ?? 24) === 12 ? 128 : 256;
    return bip39GenerateMnemonic(wordlist, strength);
}

export function isValidMnemonic(mnemonic: string): boolean {
    return validateMnemonic(mnemonic, wordlist);
}
