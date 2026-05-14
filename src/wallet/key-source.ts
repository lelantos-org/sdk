// Key-source resolver: mnemonic / EIP-712 sig / raw nsk → nsk field
// element. Callers persist the source, never the derived nsk.

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

/// ASCII bytes of `"lelantos.privateKey.nsk\0"`. Bumping invalidates
/// every nsk derived from this path; do not change without coordinated migration.
const PK_DOMAIN_TAG_HEX = "6c656c616e746f732e707269766174654b65792e6e736b00";

/// Mnemonic + account → nsk via ZIP-32-lite at m/32'/LELANTOS_COIN_TYPE'/account'.
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

/// `keccak256(domainTag || privKey) mod BABYJUB_SUBGROUP_ORDER`.
/// Domain-separated from EIP-712 sig reduction to prevent collisions
/// when a signature equals the raw key bytes.
export function hexPrivateKeyToNsk(hex: string): Field {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
        throw new Error("expected 0x-prefixed 32-byte hex private key");
    }
    const digest = keccak256(`0x${PK_DOMAIN_TAG_HEX}${hex.slice(2).toLowerCase()}`);
    const r = BigInt(digest) % BABYJUB_SUBGROUP_ORDER;
    return r === 0n ? 1n : r;
}

/// 24 words (default) = 256-bit; 12 = 128-bit.
export function generateMnemonic(opts: { words?: 12 | 24 } = {}): string {
    const strength = (opts.words ?? 24) === 12 ? 128 : 256;
    return bip39GenerateMnemonic(wordlist, strength);
}

export function isValidMnemonic(mnemonic: string): boolean {
    return validateMnemonic(mnemonic, wordlist);
}
