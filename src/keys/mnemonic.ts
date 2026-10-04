// Mnemonic generation and validation, and the synchronous key-source resolver. Everything here
// needs the BIP-39 word list statically; `./key-source.ts` holds the parts that do not.

import { generateMnemonic as bip39GenerateMnemonic, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import type { Field } from "../crypto/poseidon.js";
import { mnemonicToAccountKey } from "./hd.js";
import { type KeySource, resolveDirectNsk } from "./key-source.js";
import { type DerivedWalletKeys, type DeriveFromMnemonicOpts, deriveKeysFromNsk } from "./keys.js";

export function resolveNsk(source: KeySource): Field {
    if (source.type !== "mnemonic") return resolveDirectNsk(source);
    // ZIP-32-lite at m/32'/LELANTOS_COIN_TYPE'/account'.
    return mnemonicToAccountKey(source.mnemonic, source.account, source.passphrase).nsk;
}

/** Mnemonic → `{ keys, address, nsk }`. Wraps `mnemonicToAccountKey` + `deriveKeysFromNsk`. */
export async function deriveKeysFromMnemonic(
    opts: DeriveFromMnemonicOpts,
): Promise<DerivedWalletKeys & { nsk: Field }> {
    const esk = mnemonicToAccountKey(opts.mnemonic, opts.account ?? 0, opts.passphrase ?? "");
    const out = await deriveKeysFromNsk(esk.nsk, { P: opts.P, J: opts.J });
    return { ...out, nsk: esk.nsk };
}

/** 24 words (default) = 256-bit; 12 = 128-bit. */
export function generateMnemonic(opts: { words?: 12 | 24 } = {}): string {
    const strength = (opts.words ?? 24) === 12 ? 128 : 256;
    return bip39GenerateMnemonic(wordlist, strength);
}

export function isValidMnemonic(mnemonic: string): boolean {
    return validateMnemonic(mnemonic, wordlist);
}
