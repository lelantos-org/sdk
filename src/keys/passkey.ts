// WebAuthn PRF → nsk.
//
// As in `metamask.ts`, this module owns the domain separation and the reduction; the caller owns
// the ceremony. Nothing here touches `navigator.credentials`, since the SDK also runs in Node.
//
// The PRF extension is the only deterministic secret a passkey can produce. An assertion
// signature cannot be used the way `metamask.ts` uses an EIP-712 one: WebAuthn is ECDSA over
// secp256r1 with a random nonce, so signing the same challenge twice yields different signatures.
// PRF output is keyed by (credential, salt) and is stable for the life of the credential.
//
// The credential is the wallet: there is no mnemonic behind it, so losing the authenticator loses
// the wallet. Callers offering this path should inform the user of that.

import { BABYJUB_SUBGROUP_ORDER, reduceWideToField } from "../core/field.js";
import { bytesToBareHex, hexToBytes } from "../core/hex.js";
import { keccak256, keccakExpand } from "../crypto/keccak.js";
import type { Field } from "../crypto/poseidon.js";
import { InvalidArgumentError } from "../errors/config.js";

/**
 * ASCII bytes of `"lelantos.passkey.prf.nsk.v1\0"`.
 *
 * Distinct from `PK_DOMAIN_TAG_HEX` in `key-source.ts` and from the EIP-712 path, so PRF output
 * equal to a private key still derives a different wallet. Changing it invalidates every
 * passkey-derived wallet and requires a coordinated migration.
 */
const PRF_DOMAIN_TAG_HEX = "6c656c616e746f732e706173736b65792e7072662e6e736b2e763100";

/**
 * The salt to pass as WebAuthn's `prf.eval.first`.
 *
 * Must never change: the authenticator's PRF is keyed by (credential, salt), so a different salt
 * yields a different secret and therefore a different wallet.
 *
 * Derived as `keccak256` of an ASCII tag so the 32-byte value the extension takes stays auditable.
 */
export const LELANTOS_PRF_SALT: Uint8Array = hexToBytes(
    keccak256(hexToBytes("0x6c656c616e746f732e706173736b65792e7072662e73616c742e763100")),
);

/**
 * The WebAuthn ceremony the derivation depends on.
 *
 * Runs an assertion with the PRF extension and returns `prf.results.first`. Implementations live
 * in the browser (see the webapp's `features/passkey`); tests use a fixed array.
 */
export interface PrfEvaluator {
    /** The 32 bytes of `getClientExtensionResults().prf.results.first`. */
    evaluatePrf(salt: Uint8Array): Promise<Uint8Array>;
}

/**
 * `keccakExpand(domainTag || prf, 2) mod BABYJUB_SUBGROUP_ORDER`.
 *
 * Two keccak blocks, not one: a bare 256-bit digest folded into the 251-bit subgroup order skews
 * residues by about 30:29. See `reduceWideToField`.
 */
export function prfOutputToNsk(prf: Uint8Array): Field {
    if (prf.length !== 32) {
        // The value itself is key material, so only its length is reported.
        throw new InvalidArgumentError(
            `expected 32 bytes of WebAuthn PRF output, got ${prf.length}`,
            { argument: "prf" },
        );
    }
    // Same construction as `hexPrivateKeyToNsk` and `x402/ephemeral.ts`.
    const preimage = hexToBytes(`0x${PRF_DOMAIN_TAG_HEX}${bytesToBareHex(prf)}`);
    return reduceWideToField(keccakExpand(preimage, 2), BABYJUB_SUBGROUP_ORDER, "nsk");
}

/**
 * Run the ceremony and reduce its output to a spending key.
 *
 * Counterpart of `deriveNskFromSigner`. Both are deterministic, so a caller can cache the result
 * for a session and re-derive it later instead of storing it.
 */
export async function deriveNskFromPasskey(ev: PrfEvaluator): Promise<Field> {
    return prfOutputToNsk(await ev.evaluatePrf(LELANTOS_PRF_SALT));
}
