// Key-source resolver: mnemonic / EIP-712 sig / passkey PRF / raw nsk → nsk field
// element. Callers persist the source, never the derived nsk.

import { generateMnemonic as bip39GenerateMnemonic, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { assertNonZeroField, BABYJUB_SUBGROUP_ORDER, reduceWideToField } from "../core/field.js";
import { hexToBytes } from "../core/hex.js";
import { keccakExpand } from "../crypto/keccak.js";
import type { Field } from "../crypto/poseidon.js";
import { InvalidArgumentError } from "../errors/config.js";
import { mnemonicToAccountKey } from "./hd.js";
import { reduceSignatureToScalar } from "./metamask.js";
import { prfOutputToNsk } from "./passkey.js";

export type KeySource =
    | {
          type: "mnemonic";
          mnemonic: string;
          account?: number | undefined;
          passphrase?: string | undefined;
      }
    | { type: "signature"; signature: string }
    | { type: "privateKey"; hex: string }
    /**
     * Raw WebAuthn PRF output, 32 bytes, from a caller-run ceremony. See `passkey.ts` for why PRF
     * is used rather than the assertion signature.
     */
    | { type: "passkeyPrf"; prf: Uint8Array }
    | { type: "nsk"; nsk: Field };

/**
 * ASCII bytes of `"lelantos.privateKey.nsk.v1\0"`. Changing it invalidates every nsk derived from
 * this path and requires a coordinated migration.
 *
 * The version tracks the two-block reduction below, so keys from different reduction versions
 * never share a keccak input.
 */
const PK_DOMAIN_TAG_HEX = "6c656c616e746f732e707269766174654b65792e6e736b2e763100";

export function resolveNsk(source: KeySource): Field {
    switch (source.type) {
        case "mnemonic":
            // ZIP-32-lite at m/32'/LELANTOS_COIN_TYPE'/account'.
            return mnemonicToAccountKey(source.mnemonic, source.account, source.passphrase).nsk;
        case "signature":
            // `reduceSignatureToScalar` enforces length and canonical form.
            return reduceSignatureToScalar(source.signature);
        case "privateKey":
            return hexPrivateKeyToNsk(source.hex);
        case "passkeyPrf":
            // `prfOutputToNsk` enforces length and domain separation.
            return prfOutputToNsk(source.prf);
        case "nsk":
            // The only source not produced by a reduction, so the only one that can be out of
            // range. `nsk = 0` gives `pk_d = 0 · Base8 = O`, making every incoming note publicly
            // decryptable; an unreduced value aliases onto `nsk mod r`, a different wallet.
            assertNonZeroField(source.nsk, "nsk");
            return source.nsk;
    }
}

/**
 * `keccakExpand(domainTag || privKey, 2) mod BABYJUB_SUBGROUP_ORDER`.
 * Domain-separated from the EIP-712 signature reduction so a signature equal to the raw key bytes
 * cannot collide.
 *
 * Two keccak blocks, not one: a bare 256-bit digest folded into the 251-bit
 * subgroup order skews residues by about 30:29. See `reduceWideToField`.
 *
 * @internal
 */
export function hexPrivateKeyToNsk(hex: string): Field {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
        // The rejected value is a private key, so it stays out of the message.
        throw new InvalidArgumentError("expected a 0x-prefixed 32-byte hex private key", {
            argument: "hex",
        });
    }
    const preimage = hexToBytes(`0x${PK_DOMAIN_TAG_HEX}${hex.slice(2).toLowerCase()}`);
    return reduceWideToField(keccakExpand(preimage, 2), BABYJUB_SUBGROUP_ORDER, "nsk");
}

/** 24 words (default) = 256-bit; 12 = 128-bit. */
export function generateMnemonic(opts: { words?: 12 | 24 } = {}): string {
    const strength = (opts.words ?? 24) === 12 ? 128 : 256;
    return bip39GenerateMnemonic(wordlist, strength);
}

export function isValidMnemonic(mnemonic: string): boolean {
    return validateMnemonic(mnemonic, wordlist);
}
