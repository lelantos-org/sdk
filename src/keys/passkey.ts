// WebAuthn PRF → nsk.
//
// This module owns the domain separation and the reduction; the caller runs the ceremony, so
// nothing here touches `navigator.credentials` and the module also runs in Node.
//
// An assertion signature cannot seed the key: WebAuthn signs with a random nonce, so the same
// challenge yields a different signature each time. PRF output is keyed by (credential, salt) and
// is stable for the life of the credential.
//
// The credential is the wallet: no mnemonic backs it, so losing the authenticator loses the
// wallet.

import { BABYJUB_SUBGROUP_ORDER, reduceWideToField } from "../core/field.js";
import { bytesToBareHex, hexToBytes } from "../core/hex.js";
import { keccak256, keccakExpand } from "../crypto/keccak.js";
import type { Field } from "../crypto/poseidon.js";
import { InvalidArgumentError } from "../errors/config.js";

/**
 * ASCII bytes of `"lelantos.passkey.prf.nsk.v1\0"`.
 *
 * Distinct from `PK_DOMAIN_TAG_HEX` in `key-source.ts` and from the EIP-712 path, so PRF output
 * equal to a private key still derives a different wallet. Changing it changes every
 * passkey-derived wallet.
 */
const PRF_DOMAIN_TAG_HEX = "6c656c616e746f732e706173736b65792e7072662e6e736b2e763100";

/**
 * The salt to pass as WebAuthn's `prf.eval.first`: `keccak256` of the ASCII tag
 * `"lelantos.passkey.prf.salt.v1\0"`.
 *
 * Must never change: the authenticator's PRF is keyed by (credential, salt), so a different salt
 * yields a different secret and therefore a different wallet.
 */
export const LELANTOS_PRF_SALT: Uint8Array = hexToBytes(
    keccak256(hexToBytes("0x6c656c616e746f732e706173736b65792e7072662e73616c742e763100")),
);

/**
 * The WebAuthn ceremony the derivation depends on, supplied by the caller: an assertion with the
 * PRF extension that returns `prf.results.first`.
 */
export interface PrfEvaluator {
    /** The 32 bytes of `getClientExtensionResults().prf.results.first`. */
    evaluatePrf(salt: Uint8Array): Promise<Uint8Array>;
}

/**
 * `keccakExpand(domainTag || prf, 2) mod BABYJUB_SUBGROUP_ORDER`. Two keccak blocks: see
 * `reduceWideToField` on folding a bare digest.
 */
export function prfOutputToNsk(prf: Uint8Array): Field {
    if (prf.length !== 32) {
        // The value itself is key material, so only its length is reported.
        throw new InvalidArgumentError(
            `expected 32 bytes of WebAuthn PRF output, got ${prf.length}`,
            { argument: "prf" },
        );
    }
    const preimage = hexToBytes(`0x${PRF_DOMAIN_TAG_HEX}${bytesToBareHex(prf)}`);
    return reduceWideToField(keccakExpand(preimage, 2), BABYJUB_SUBGROUP_ORDER, "nsk");
}

/**
 * Run the ceremony and reduce its output to a spending key.
 *
 * Deterministic, so a caller can cache the result for a session and re-derive it later instead of
 * storing it.
 */
export async function deriveNskFromPasskey(ev: PrfEvaluator): Promise<Field> {
    return prfOutputToNsk(await ev.evaluatePrf(LELANTOS_PRF_SALT));
}
