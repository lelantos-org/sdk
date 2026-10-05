// Key-source resolver: mnemonic / EIP-712 signature / private key / passkey PRF / raw nsk → nsk
// field element. Callers persist the source, never the derived nsk.
//
// This module does not import the mnemonic derivation statically: `loadNsk` loads it on first
// use, so a wallet built from another source does not bundle the BIP-39 word list. The synchronous
// resolver, which needs it statically, is in `./mnemonic.ts`.

import { assertNonZeroField, BABYJUB_SUBGROUP_ORDER, reduceWideToField } from "../core/field.js";
import { hexToBytes } from "../core/hex.js";
import { keccakExpand } from "../crypto/keccak.js";
import type { Field } from "../crypto/poseidon.js";
import { InvalidArgumentError } from "../errors/config.js";
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
    /** Raw WebAuthn PRF output, 32 bytes, from a caller-run ceremony. See `passkey.ts`. */
    | { type: "passkeyPrf"; prf: Uint8Array }
    | { type: "nsk"; nsk: Field };

/**
 * ASCII bytes of `"lelantos.privateKey.nsk.v1\0"`. Changing it changes every nsk derived from a
 * private key. The version denotes the two-block reduction below, so different reductions never
 * share a keccak input.
 */
const PK_DOMAIN_TAG_HEX = "6c656c616e746f732e707269766174654b65792e6e736b2e763100";

/** A key source that resolves without the mnemonic derivation. */
export type DirectKeySource = Exclude<KeySource, { type: "mnemonic" }>;

/**
 * The nsk of every source but a mnemonic.
 *
 * @internal
 */
export function resolveDirectNsk(source: DirectKeySource): Field {
    switch (source.type) {
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
            // range. `nsk = 0` is a publicly known key; an unreduced value aliases onto
            // `nsk mod r`, a different wallet.
            assertNonZeroField(source.nsk, "nsk");
            return source.nsk;
    }
}

/**
 * The nsk of any source. A mnemonic loads its derivation (ZIP-32-lite at
 * m/32'/LELANTOS_COIN_TYPE'/account') on first use.
 *
 * @internal
 */
export async function loadNsk(source: KeySource): Promise<Field> {
    if (source.type !== "mnemonic") return resolveDirectNsk(source);
    const { mnemonicToAccountKey } = await import("./hd.js");
    return mnemonicToAccountKey(source.mnemonic, source.account, source.passphrase).nsk;
}

/**
 * `keccakExpand(domainTag || privKey, 2) mod BABYJUB_SUBGROUP_ORDER`.
 * Domain-separated from the EIP-712 signature reduction so a signature equal to the raw key bytes
 * cannot collide. Two keccak blocks: see `reduceWideToField` on folding a bare digest.
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
