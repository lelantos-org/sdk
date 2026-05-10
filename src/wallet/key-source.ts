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
import { keccak256 } from "ethers";
import { BABYJUB_SUBGROUP_ORDER, type Field } from "../crypto/index.js";
import * as metamask from "../metamask.js";
import { mnemonicToAccountKey } from "./hd.js";

export type KeySource =
    | { type: "mnemonic"; mnemonic: string; account?: number; passphrase?: string }
    | { type: "signature"; signature: string }
    | { type: "privateKey"; hex: string }
    | { type: "nsk"; nsk: Field };

/// Domain tag bound into the hex-private-key → nsk derivation. Encoded
/// ASCII bytes of `"lelantos.privateKey.nsk\0"`. Bumping this value
/// invalidates every nsk derived from this path; do not change without
/// a coordinated migration.
const PK_DOMAIN_TAG_HEX = "6c656c616e746f732e707269766174654b65792e6e736b00";

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
        case "privateKey":
            return hexPrivateKeyToNsk(source.hex);
        case "nsk":
            return source.nsk;
    }
}

/// Derive an nsk directly from a 32-byte hex EVM private key.
/// `keccak256(domainTag || privKey) mod BABYJUB_SUBGROUP_ORDER`.
/// Domain-separated so this nsk cannot collide with values derived
/// from EIP-712 signatures (`reduceSignatureToScalar`) — even when the
/// signature happens to equal the raw key bytes.
///
/// Useful for backend services that already own a 0x-hex EVM key and
/// want to add shielded support without managing a separate mnemonic.
/// The same hex always yields the same nsk; persist the hex (never the
/// nsk) — losing the hex loses spend authority for the address.
export function hexPrivateKeyToNsk(hex: string): Field {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
        throw new Error("expected 0x-prefixed 32-byte hex private key");
    }
    const digest = keccak256(`0x${PK_DOMAIN_TAG_HEX}${hex.slice(2).toLowerCase()}`);
    const r = BigInt(digest) % BABYJUB_SUBGROUP_ORDER;
    return r === 0n ? 1n : r;
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
