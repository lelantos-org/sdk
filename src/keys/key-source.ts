// Key-source resolver: mnemonic / EIP-712 sig / raw nsk → nsk field
// element. Callers persist the source, never the derived nsk.

import { generateMnemonic as bip39GenerateMnemonic, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { assertNonZeroField, BABYJUB_SUBGROUP_ORDER } from "../core/field.js";
import { keccak256 } from "../core/keccak.js";
import type { Field } from "../crypto/poseidon.js";
import { mnemonicToAccountKey } from "./hd.js";
import { reduceSignatureToScalar } from "./metamask.js";

export type KeySource =
    | {
          type: "mnemonic";
          mnemonic: string;
          account?: number | undefined;
          passphrase?: string | undefined;
      }
    | { type: "signature"; signature: string }
    | { type: "privateKey"; hex: string }
    | { type: "nsk"; nsk: Field };

/**
 * ASCII bytes of `"lelantos.privateKey.nsk\0"`. Bumping invalidates
 * every nsk derived from this path; do not change without coordinated migration.
 */
const PK_DOMAIN_TAG_HEX = "6c656c616e746f732e707269766174654b65792e6e736b00";

/**
 * Mnemonic + account → nsk via ZIP-32-lite at m/32'/LELANTOS_COIN_TYPE'/account'.
 *
 * @internal
 */
export function mnemonicToNsk(mnemonic: string, account = 0, passphrase = ""): Field {
    return mnemonicToAccountKey(mnemonic, account, passphrase).nsk;
}

export function resolveNsk(source: KeySource): Field {
    switch (source.type) {
        case "mnemonic":
            return mnemonicToNsk(source.mnemonic, source.account ?? 0, source.passphrase);
        case "signature":
            // Length and canonical form are enforced by
            // `reduceSignatureToScalar`, which owns the signature encoding.
            return reduceSignatureToScalar(source.signature);
        case "privateKey":
            return hexPrivateKeyToNsk(source.hex);
        case "nsk":
            // The only source that is not the output of a reduction, so it is
            // the only one that can be out of range. `nsk = 0` gives
            // `pk_d = 0 · Base8 = O`, a wallet whose ECDH key is the identity
            // and whose every incoming note is publicly decryptable; an
            // unreduced value silently aliases onto `nsk mod r`, i.e. a
            // different wallet than the caller named.
            assertNonZeroField(source.nsk, "nsk");
            return source.nsk;
    }
}

/**
 * `keccak256(domainTag || privKey) mod BABYJUB_SUBGROUP_ORDER`.
 * Domain-separated from EIP-712 sig reduction to prevent collisions
 * when a signature equals the raw key bytes.
 *
 * @internal
 */
export function hexPrivateKeyToNsk(hex: string): Field {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
        throw new Error("expected 0x-prefixed 32-byte hex private key");
    }
    const digest = keccak256(
        `0x${PK_DOMAIN_TAG_HEX}${hex.slice(2).toLowerCase()}` as `0x${string}`,
    );
    const r = BigInt(digest) % BABYJUB_SUBGROUP_ORDER;
    return r === 0n ? 1n : r;
}

/** 24 words (default) = 256-bit; 12 = 128-bit. */
export function generateMnemonic(opts: { words?: 12 | 24 } = {}): string {
    const strength = (opts.words ?? 24) === 12 ? 128 : 256;
    return bip39GenerateMnemonic(wordlist, strength);
}

export function isValidMnemonic(mnemonic: string): boolean {
    return validateMnemonic(mnemonic, wordlist);
}
